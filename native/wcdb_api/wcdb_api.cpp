#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <array>
#include <cctype>
#include <memory>
#include <mutex>
#include <queue>
#include <set>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <thread>
#include <atomic>
#include <openssl/evp.h>
#include "sqlite3.h"
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#define WF_EXPORT extern "C" __declspec(dllexport)
#else
#define WF_EXPORT extern "C"
#endif
namespace {
struct Account {
    sqlite3* db = nullptr;
    std::string wxid;
    std::vector<std::string> messagePaths;
    std::vector<sqlite3*> messageDbs;
    std::unordered_set<std::string> antiRevokeSessions;
    bool snsBlockDelete = false;
};
struct Cursor {
    int64_t handle = 0;
    std::string session;
    int32_t batchSize = 100;
    int32_t offset = 0;
    int32_t ascending = 0;
    int32_t beginTimestamp = 0;
    int32_t endTimestamp = 0;
    bool fetched = false;
    std::string payload;
};
std::mutex mu;
std::atomic<bool> monitorRunning{false};
std::thread monitorThread;
std::unordered_map<int64_t, std::unique_ptr<Account>> accounts;
std::unordered_map<int64_t, Cursor> cursors;
int64_t nextHandle = 1;
int64_t nextCursor = 1;
Account* get(int64_t h) { std::lock_guard<std::mutex> lock(mu); auto it=accounts.find(h); return it==accounts.end()?nullptr:it->second.get(); }
bool path_has_component(const std::string& path, const char* component);
std::string lower(std::string s);
std::string path_filename(const std::string& path) { return lower(std::filesystem::path(path).filename().string()); }
bool indexed_db(const std::string& name,const char*prefix){const std::string stem(prefix);if(name.rfind(stem,0)!=0||name.size()<=stem.size()+3||name.substr(name.size()-3)!=".db")return false;return std::all_of(name.begin()+stem.size(),name.end()-3,[](unsigned char c){return std::isdigit(c)!=0;});}
bool is_media_db_path(const std::string& path) { const auto name=path_filename(path); return indexed_db(name,"media_") || name=="media.db"; }
bool is_message_db_path(const std::string& path) { const auto name=path_filename(path); return path_has_component(path,"message") && (indexed_db(name,"message_") || indexed_db(name,"biz_message_") || name=="message.db"); }
sqlite3* database_for(Account* a, const char* kind, const char* path) {
    if (!a) return nullptr;
    if ((!path || !*path) && kind && _stricmp(kind,"session")==0) return a->db;
    if (path && *path) {
        for (size_t i = 0; i < a->messagePaths.size(); ++i) if (_stricmp(a->messagePaths[i].c_str(), path) == 0) return a->messageDbs[i];
        return nullptr;
    }
    if (kind && *kind) {
        for (size_t i = 0; i < a->messagePaths.size(); ++i) {
            const auto& candidate=a->messagePaths[i];
            if (_stricmp(kind,"media")==0 ? is_media_db_path(candidate) : _stricmp(kind,"message")==0 ? is_message_db_path(candidate) : path_has_component(candidate,kind)) return a->messageDbs[i];
        }
    }
    return kind && *kind ? nullptr : a->db;
}
std::string lower(std::string s) { for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return s; }
bool has_name(const std::string& value, const char* wanted) { return _stricmp(value.c_str(), wanted) == 0; }
bool path_has_component(const std::string& path, const char* component) {
    const auto needle = lower(component);
    std::string p = lower(path);
    for (char& c : p) if (c == '\\') c = '/';
    std::string token;
    for (char c : p + '/') {
        if (c == '/') { if (token == needle) return true; token.clear(); } else token += c;
    }
    return false;
}
void out(void** p,const std::string& v){ if(!p)return; *p=std::malloc(v.size()+1); if(*p)std::memcpy(*p,v.c_str(),v.size()+1); }
int fail(void** p,const std::string& m,int c=-1){out(p,std::string("{\"error\":\"")+m+"\"}");return c;}
std::string esc(const unsigned char* t){if(!t)return{};std::string s;static const char hex[]="0123456789abcdef";for(auto p=t;*p;++p){const unsigned char c=*p;switch(c){case '\\':s+="\\\\";break;case '"':s+="\\\"";break;case '\n':s+="\\n";break;case '\r':s+="\\r";break;case '\t':s+="\\t";break;default:if(c<0x20){s+="\\u00";s+=hex[(c>>4)&15];s+=hex[c&15];}else s+=char(c);}}return s;}
std::string cell(sqlite3_stmt* st,int i){switch(sqlite3_column_type(st,i)){case SQLITE_NULL:return"null";case SQLITE_INTEGER:return std::to_string(sqlite3_column_int64(st,i));case SQLITE_FLOAT:return std::to_string(sqlite3_column_double(st,i));case SQLITE_BLOB:{static constexpr char digits[]="0123456789abcdef";const auto* p=static_cast<const unsigned char*>(sqlite3_column_blob(st,i));const int n=sqlite3_column_bytes(st,i);std::string value="\"";for(int k=0;k<n;++k){value+=digits[p[k]>>4];value+=digits[p[k]&15];}return value+'"';}default:return std::string("\"")+esc(sqlite3_column_text(st,i))+"\"";}}
std::string ident(const char* text) { std::string s = text ? text : ""; std::string out = "\""; for (char c : s) { if (c == '"') out += "\"\""; else out += c; } return out + "\""; }
std::string sql_text(const char* text) { std::string s = text ? text : ""; std::string out = "'"; for (char c : s) { if (c == '\'') out += "''"; else out += c; } return out + "'"; }
std::vector<std::string> json_strings(const char* text) {
    std::vector<std::string> result; if (!text) return result;
    const std::string s(text); bool quoted = false, escaped = false; std::string current;
    for (char c : s) {
        if (!quoted) { if (c == '"') { quoted = true; current.clear(); } continue; }
        if (escaped) { current += c; escaped = false; continue; }
        if (c == '\\') { escaped = true; continue; }
        if (c == '"') { result.push_back(current); quoted = false; continue; }
        current += c;
    }
    return result;
}
void close_dbs(Account* a) {
    if (!a) return;
    for (auto* db : a->messageDbs) if (db) sqlite3_close(db);
    a->messageDbs.clear();
    if (a->db) { sqlite3_close(a->db); a->db = nullptr; }
}
std::vector<std::string> columns(sqlite3* db, const std::string& table);
std::vector<std::string> message_tables(sqlite3* db);
std::string column_string(sqlite3_stmt* st, int index);
std::string table_schema(sqlite3* db, const std::string& table);
std::string session_predicate(const std::string& talker, const char* session);
std::string table_for_session(sqlite3* db, const char* session);
std::string find_talker_column(const std::vector<std::string>& cols);
std::string find_time_column(const std::vector<std::string>& cols);
std::string find_type_column(const std::vector<std::string>& cols);
std::string find_content_column(const std::vector<std::string>& cols);
sqlite3* db_in_component(Account* a, const char* component);
std::string choose_column(const std::vector<std::string>& cols, std::initializer_list<const char*> names);
WF_EXPORT int32_t wcdb_get_message_count(int64_t,const char*,int32_t*);
std::string table_name(Account* a, const char* preferred = nullptr) {
    if (!a || !a->db) return {};
    const char* sql = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(a->db, sql, -1, &st, nullptr) != SQLITE_OK) return {};
    std::string fallback;
    int fallbackScore = -1;
    while (sqlite3_step(st) == SQLITE_ROW) {
        const char* p = reinterpret_cast<const char*>(sqlite3_column_text(st, 0));
        if (!p) continue;
        std::string n(p);
        if (preferred && _stricmp(n.c_str(), preferred) == 0) { sqlite3_finalize(st); return n; }
        int score = 0;
        const auto cols = columns(a->db, n);
        for (const auto& col : cols) {
            const auto c = lower(col);
            if (c == "username" || c == "talker" || c == "strtalker" || c == "session_id") score += 5;
            if (c == "lastmsgtime" || c == "last_msg_time" || c == "lastmessagetime" || c == "msgsvrid") score += 2;
            if (c == "nickname" || c == "remark") score += 1;
        }
        const auto ln = lower(n);
        if (ln == "sessiontable" || ln == "session" || ln == "sessions") score += 20;
        if (ln == "contact" || ln == "chat_room" || ln == "chatroom_member") score -= 20;
        if (score > fallbackScore) { fallbackScore = score; fallback = n; }
    }
    sqlite3_finalize(st);
    return fallback;
}
bool open_message_dbs(Account* a, const std::filesystem::path& sessionPath, const std::vector<unsigned char>& key) {
    if (!a) return false;
    std::filesystem::path root = sessionPath.parent_path();
    if (_stricmp(root.filename().string().c_str(), "session") == 0) root = root.parent_path();
    std::error_code ec;
    for (auto it = std::filesystem::recursive_directory_iterator(root, ec); !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
        if (ec || !it->is_regular_file(ec)) continue;
        auto p = it->path();
        if (_stricmp(p.filename().string().c_str(), sessionPath.filename().string().c_str()) == 0) continue;
        if (_stricmp(p.extension().string().c_str(), ".db") != 0) continue;
        sqlite3* db = nullptr;
        if (sqlite3_open_v2(p.string().c_str(), &db, SQLITE_OPEN_READWRITE, nullptr) != SQLITE_OK || !db) { if (db) sqlite3_close(db); continue; }
        if (sqlite3_key(db, key.data(), static_cast<int>(key.size())) != SQLITE_OK) { sqlite3_close(db); db=nullptr; }
        sqlite3_stmt* probe = nullptr;
        int rc = db ? sqlite3_prepare_v2(db, "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1", -1, &probe, nullptr) : SQLITE_ERROR;
        if (rc == SQLITE_OK) rc = sqlite3_step(probe);
        if (probe) sqlite3_finalize(probe);
        if (rc != SQLITE_ROW && rc != SQLITE_DONE) {
            if (db) sqlite3_close(db);
            db=nullptr;
            if (sqlite3_open_v2(p.string().c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK || !db) { if (db) sqlite3_close(db); continue; }
            probe=nullptr;
            rc=sqlite3_prepare_v2(db, "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1", -1, &probe, nullptr);
            if (rc==SQLITE_OK) rc=sqlite3_step(probe);
            if (probe) sqlite3_finalize(probe);
        }
        if (rc == SQLITE_ROW || rc == SQLITE_DONE) { a->messagePaths.push_back(p.string()); a->messageDbs.push_back(db); }
        else sqlite3_close(db);
    }
    return true;
}
int query_db(sqlite3* db,const char* sql,std::string& j,bool& first,int* rowCount=nullptr){if(!db||!sql)return-1;sqlite3_stmt* st=nullptr;int rc=sqlite3_prepare_v2(db,sql,-1,&st,nullptr);if(rc!=SQLITE_OK)return rc;while((rc=sqlite3_step(st))==SQLITE_ROW){if(rowCount)++*rowCount;if(!first)j+=',';first=false;j+='{';for(int i=0;i<sqlite3_column_count(st);++i){if(i)j+=',';j+='"'+esc(reinterpret_cast<const unsigned char*>(sqlite3_column_name(st,i)))+"\":"+cell(st,i);}j+='}';}sqlite3_finalize(st);return rc==SQLITE_DONE?0:rc;}
std::string json_key(const unsigned char* text) { return std::string("\"") + esc(text) + "\":"; }
std::string column_string(sqlite3_stmt* st, int index) {
    if (sqlite3_column_type(st, index) == SQLITE_NULL) return {};
    const auto* text = sqlite3_column_text(st, index);
    return text ? reinterpret_cast<const char*>(text) : std::to_string(sqlite3_column_int64(st, index));
}
std::string query_pairs(sqlite3* db, const std::string& sql, int keyIndex, int valueIndex, bool numericValue = false) {
    std::string outJson = "{"; bool first = true; sqlite3_stmt* st = nullptr;
    if (!db || sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return "{}";
    while (sqlite3_step(st) == SQLITE_ROW) {
        const auto key = column_string(st, keyIndex); if (key.empty()) continue;
        if (!first) outJson += ','; first = false; outJson += '"' + esc(reinterpret_cast<const unsigned char*>(key.c_str())) + "\":";
        if (numericValue) outJson += sqlite3_column_int(st, valueIndex) ? "true" : "false";
        else outJson += '"' + esc(reinterpret_cast<const unsigned char*>(column_string(st, valueIndex).c_str())) + '"';
    }
    if (st) sqlite3_finalize(st); return outJson + "}";
}
std::string choose_column(const std::vector<std::string>& cols, std::initializer_list<const char*> names) {
    for (const char* wanted : names) for (const auto& col : cols) if (_stricmp(col.c_str(), wanted) == 0) return col;
    return {};
}
std::string contact_table(sqlite3* db) {
    if (!db) return {};
    for (const auto& table : message_tables(db)) if (_stricmp(table.c_str(), "contact") == 0) return table;
    return {};
}
std::string contact_rows(Account* a, const char* usernamesJson) {
    auto* db = db_in_component(a, "contact"); if (!db) db = a ? a->db : nullptr;
    const auto table = contact_table(db); if (table.empty()) return "[]";
    const auto cols = columns(db, table); const auto username = choose_column(cols, {"username", "user_name", "userName"});
    if (username.empty()) return "[]";
    std::string sql = "SELECT * FROM " + ident(table.c_str());
    const auto ids = json_strings(usernamesJson);
    if (!ids.empty()) { sql += " WHERE " + ident(username.c_str()) + " IN ("; for (size_t i=0;i<ids.size();++i) { if(i) sql += ','; sql += sql_text(ids[i].c_str()); } sql += ')'; }
    sql += " LIMIT 50000";
    std::string outJson = "["; bool first = true; sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return "[]";
    while (sqlite3_step(st) == SQLITE_ROW) {
        if (!first) outJson += ','; first = false; outJson += '{';
        for (int i=0; i<sqlite3_column_count(st); ++i) { if (i) outJson += ','; outJson += json_key(reinterpret_cast<const unsigned char*>(sqlite3_column_name(st,i))) + cell(st,i); }
        outJson += '}';
    }
    if (st) sqlite3_finalize(st); return outJson + "]";
}
std::string contact_value_map(Account* a, const char* usernamesJson, const char* valueKind) {
    auto* db = db_in_component(a, "contact"); if (!db) db = a ? a->db : nullptr;
    const auto table = contact_table(db); if (table.empty()) return "{}";
    const auto cols = columns(db, table); const auto username = choose_column(cols, {"username", "user_name", "userName"});
    if (username.empty()) return "{}";
    std::vector<std::string> displayValues;
    std::string value;
    if (std::strcmp(valueKind, "display") == 0) {
        for (const char* candidate : {"remark", "nick_name", "nickName", "nickname", "NickName", "alias", "display_name", "displayName", "group_name", "chatroom_name"}) {
            const auto column = choose_column(cols, {candidate});
            if (!column.empty() && std::find(displayValues.begin(), displayValues.end(), column) == displayValues.end()) displayValues.push_back(column);
        }
        if (displayValues.empty()) return "{}";
        std::unordered_map<std::string, std::string> displays;
        std::string displaySql = "SELECT " + ident(username.c_str());
        for (const auto& column : displayValues) displaySql += "," + ident(column.c_str());
        displaySql += " FROM " + ident(table.c_str());
        const auto ids = json_strings(usernamesJson);
        if (!ids.empty()) { displaySql += " WHERE " + ident(username.c_str()) + " IN ("; for (size_t i=0;i<ids.size();++i) { if(i) displaySql += ','; displaySql += sql_text(ids[i].c_str()); } displaySql += ')'; }
        sqlite3_stmt* displayStmt = nullptr;
        if (sqlite3_prepare_v2(db, displaySql.c_str(), -1, &displayStmt, nullptr) == SQLITE_OK) {
            while (sqlite3_step(displayStmt) == SQLITE_ROW) {
                const auto key = column_string(displayStmt, 0); if (key.empty()) continue;
                for (int i=1; i<sqlite3_column_count(displayStmt); ++i) { const auto value = column_string(displayStmt, i); if (!value.empty()) { displays[key] = value; break; } }
                if (!displays.count(key)) displays[key] = {};
            }
        }
        if (displayStmt) sqlite3_finalize(displayStmt);
        const auto roomCols = columns(db, "chat_room");
        const auto roomUser = choose_column(roomCols, {"username", "user_name", "userName"});
        const auto roomName = choose_column(roomCols, {"name", "room_name", "roomName", "roomname", "display_name", "displayName", "chatroom_name", "chatroomName", "nick_name", "nickname", "remark"});
        if (!roomUser.empty() && !roomName.empty()) {
            std::string roomSql = "SELECT " + ident(roomUser.c_str()) + "," + ident(roomName.c_str()) + " FROM \"chat_room\"";
            if (!ids.empty()) { roomSql += " WHERE " + ident(roomUser.c_str()) + " IN ("; for (size_t i=0;i<ids.size();++i) { if(i) roomSql += ','; roomSql += sql_text(ids[i].c_str()); } roomSql += ')'; }
            sqlite3_stmt* roomStmt = nullptr;
            if (sqlite3_prepare_v2(db, roomSql.c_str(), -1, &roomStmt, nullptr) == SQLITE_OK) while (sqlite3_step(roomStmt) == SQLITE_ROW) {
                const auto key = column_string(roomStmt, 0), name = column_string(roomStmt, 1);
                if (!key.empty() && !name.empty() && (displays.find(key) == displays.end() || displays[key].empty())) displays[key] = name;
            }
            if (roomStmt) sqlite3_finalize(roomStmt);
        }
        std::string result = "{"; bool firstDisplay = true;
        for (const auto& [key, display] : displays) { if (!firstDisplay) result += ','; firstDisplay = false; result += '"' + esc(reinterpret_cast<const unsigned char*>(key.c_str())) + "\":\"" + esc(reinterpret_cast<const unsigned char*>(display.c_str())) + '"'; }
        return result + "}";
    }
    else if (std::strcmp(valueKind, "avatar") == 0) value = choose_column(cols, {"big_head_img_url", "bigHeadImgUrl", "small_head_img_url", "head_img_url", "avatar_url"});
    else if (std::strcmp(valueKind, "alias") == 0) value = choose_column(cols, {"alias", "Alias"});
    else if (std::strcmp(valueKind, "friend") == 0) value = choose_column(cols, {"flag", "contact_flag", "local_type"});
    if (std::strcmp(valueKind, "display") != 0 && value.empty()) return "{}";
    std::string sql = "SELECT " + ident(username.c_str());
    if (std::strcmp(valueKind, "display") == 0) for (const auto& column : displayValues) sql += "," + ident(column.c_str());
    else sql += "," + ident(value.c_str());
    sql += " FROM " + ident(table.c_str());
    const auto ids = json_strings(usernamesJson);
    if (!ids.empty()) { sql += " WHERE " + ident(username.c_str()) + " IN ("; for (size_t i=0;i<ids.size();++i) { if(i) sql += ','; sql += sql_text(ids[i].c_str()); } sql += ')'; }
    std::string outJson = "{"; bool first = true; sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return "{}";
    while (sqlite3_step(st) == SQLITE_ROW) {
        const auto key = column_string(st, 0); if (key.empty()) continue;
        if (!first) outJson += ','; first = false; outJson += '"' + esc(reinterpret_cast<const unsigned char*>(key.c_str())) + "\":";
        if (std::strcmp(valueKind, "friend") == 0) outJson += sqlite3_column_int(st, 1) ? "true" : "false";
        else if (std::strcmp(valueKind, "display") == 0) {
            std::string display;
            for (int i = 1; i < sqlite3_column_count(st); ++i) {
                display = column_string(st, i);
                if (!display.empty()) break;
            }
            if (display.empty() && key.find("@chatroom") != std::string::npos) {
                const auto roomCols = columns(db, "chat_room");
                const auto roomUser = choose_column(roomCols, {"username", "user_name", "userName"});
                const auto roomName = choose_column(roomCols, {"name", "room_name", "roomName", "roomname", "display_name", "displayName", "chatroom_name", "chatroomName", "nick_name", "nickname", "remark"});
                if (!roomUser.empty() && !roomName.empty()) {
                    const auto roomSql = "SELECT " + ident(roomName.c_str()) + " FROM \"chat_room\" WHERE " + ident(roomUser.c_str()) + "=" + sql_text(key.c_str()) + " LIMIT 1";
                    sqlite3_stmt* roomStmt = nullptr;
                    if (sqlite3_prepare_v2(db, roomSql.c_str(), -1, &roomStmt, nullptr) == SQLITE_OK && sqlite3_step(roomStmt) == SQLITE_ROW) display = column_string(roomStmt, 0);
                    if (roomStmt) sqlite3_finalize(roomStmt);
                }
            }
            outJson += '"' + esc(reinterpret_cast<const unsigned char*>(display.c_str())) + '"';
        } else outJson += '"' + esc(reinterpret_cast<const unsigned char*>(column_string(st, 1).c_str())) + '"';
    }
    if (st) sqlite3_finalize(st); return outJson + "}";
}
std::string group_member_sql(const char* room) {
    return " FROM chatroom_member m JOIN chat_room r ON r.id=m.room_id JOIN contact c ON c.id=m.member_id WHERE r.username=" + sql_text(room);
}
bool read_varint(const unsigned char* bytes, size_t size, size_t& position, size_t& value) {
    value = 0;
    for (unsigned int shift = 0; position < size && shift <= 28; shift += 7) {
        const unsigned char byte = bytes[position++];
        value |= static_cast<size_t>(byte & 0x7f) << shift;
        if ((byte & 0x80) == 0) return true;
    }
    return false;
}
bool likely_member_id(const std::string& value) {
    if (value.size() < 4 || value.size() > 80 || !std::isalpha(static_cast<unsigned char>(value[0])) || value.find("@chatroom") != std::string::npos) return false;
    return std::all_of(value.begin() + 1, value.end(), [](unsigned char c) { return std::isalnum(c) || c == '_' || c == '.' || c == '@' || c == '-'; });
}
std::string group_nicknames(const unsigned char* bytes, size_t size) {
    std::unordered_map<std::string, std::string> names;
    std::set<std::string> conflicts;
    if (!bytes) return "{}";
    for (size_t i = 0; i + 2 < size; ++i) {
        if (bytes[i] != 0x0a) continue;
        size_t cursor = i + 1, idSize = 0, nickSize = 0;
        if (!read_varint(bytes, size, cursor, idSize) || idSize == 0 || idSize > 96 || idSize > size - cursor) continue;
        std::string id(reinterpret_cast<const char*>(bytes + cursor), idSize);
        if (!likely_member_id(id)) continue;
        cursor += idSize;
        if (cursor >= size || bytes[cursor++] != 0x12 || !read_varint(bytes, size, cursor, nickSize) || nickSize == 0 || nickSize > 128 || nickSize > size - cursor) continue;
        std::string nickname(reinterpret_cast<const char*>(bytes + cursor), nickSize);
        nickname.erase(std::remove_if(nickname.begin(), nickname.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; }), nickname.end());
        const auto start = nickname.find_first_not_of(" \t\r\n");
        if (start == std::string::npos) continue;
        nickname = nickname.substr(start, nickname.find_last_not_of(" \t\r\n") - start + 1);
        if (nickname.empty() || nickname.find("@chatroom") != std::string::npos || lower(nickname).rfind("wxid_", 0) == 0) continue;
        id = lower(id);
        if (const auto it = names.find(id); it != names.end() && it->second != nickname) conflicts.insert(id);
        else names.emplace(id, nickname);
        i = cursor + nickSize - 1;
    }
    std::string json = "{";
    bool first = true;
    for (const auto& [id, nickname] : names) {
        if (conflicts.count(id)) continue;
        if (!first) json += ',';
        first = false;
        json += '"' + esc(reinterpret_cast<const unsigned char*>(id.c_str())) + "\":\"" + esc(reinterpret_cast<const unsigned char*>(nickname.c_str())) + '"';
    }
    return json + "}";
}
int32_t group_member_count(Account* a, const char* room) {
    auto* db=db_in_component(a,"contact");if(!db||!room)return -1;
    const auto sql="SELECT count(*)"+group_member_sql(room);
    sqlite3_stmt* st=nullptr;
    if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return -1;
    const int32_t count=sqlite3_step(st)==SQLITE_ROW?sqlite3_column_int(st,0):-1;
    sqlite3_finalize(st);return count;
}
std::string json_string_array(const std::vector<std::string>& values) { std::string j="["; for(size_t i=0;i<values.size();++i){if(i)j+=',';j+='"'+esc(reinterpret_cast<const unsigned char*>(values[i].c_str()))+'"';} return j+"]"; }
std::string table_schema(sqlite3* db, const std::string& table) {
    if (!db || table.empty()) return {};
    std::string sql="SELECT sql FROM sqlite_master WHERE type='table' AND name="+sql_text(table.c_str())+" LIMIT 1"; sqlite3_stmt* st=nullptr; std::string value;
    if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_ROW){auto* p=sqlite3_column_text(st,0);if(p)value=reinterpret_cast<const char*>(p);} if(st)sqlite3_finalize(st); return value;
}
std::string query_rows_limited(sqlite3* db, const std::string& sql) { std::string j="["; bool first=true; if(!db)return j+"]"; sqlite3_stmt*st=nullptr; if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return j+"]"; while(sqlite3_step(st)==SQLITE_ROW){if(!first)j+=',';first=false;j+='{';for(int i=0;i<sqlite3_column_count(st);++i){if(i)j+=',';j+=json_key(reinterpret_cast<const unsigned char*>(sqlite3_column_name(st,i)))+cell(st,i);}j+='}';}if(st)sqlite3_finalize(st);return j+"]"; }
std::string json_error(const char* message) { return std::string("{\"success\":false,\"error\":\"") + esc(reinterpret_cast<const unsigned char*>(message ? message : "error")) + "\"}"; }
std::string json_success_counts(int64_t rows, int columns) { return "{\"success\":true,\"rows\":" + std::to_string(rows) + ",\"columns\":" + std::to_string(columns) + "}"; }
std::string snapshot_value(sqlite3_stmt* st, int index) {
    switch (sqlite3_column_type(st, index)) {
    case SQLITE_INTEGER: return "i:" + std::to_string(sqlite3_column_int64(st, index));
    case SQLITE_FLOAT: return "f:" + std::to_string(sqlite3_column_double(st, index));
    case SQLITE_TEXT: return "t:" + std::string(reinterpret_cast<const char*>(sqlite3_column_text(st, index)));
    case SQLITE_BLOB: {
        const auto* data = static_cast<const unsigned char*>(sqlite3_column_blob(st, index));
        const int size = sqlite3_column_bytes(st, index);
        static constexpr char digits[] = "0123456789abcdef";
        std::string value = "b:";
        value.reserve(static_cast<size_t>(size) * 2 + 2);
        for (int i = 0; i < size; ++i) { value += digits[data[i] >> 4]; value += digits[data[i] & 15]; }
        return value;
    }
    default: return "n";
    }
}
bool parse_snapshot_value(const std::string& encoded, int index, sqlite3_stmt* st) {
    if (encoded == "n") return sqlite3_bind_null(st, index) == SQLITE_OK;
    if (encoded.size() < 2 || encoded[1] != ':') return false;
    const char type = encoded[0]; const std::string value = encoded.substr(2);
    char* end = nullptr;
    if (type == 'i') { const auto n = std::strtoll(value.c_str(), &end, 10); if (!end || *end) return false; return sqlite3_bind_int64(st, index, n) == SQLITE_OK; }
    if (type == 'f') { const auto n = std::strtod(value.c_str(), &end); if (!end || *end) return false; return sqlite3_bind_double(st, index, n) == SQLITE_OK; }
    if (type == 't') return sqlite3_bind_text(st, index, value.c_str(), static_cast<int>(value.size()), SQLITE_TRANSIENT) == SQLITE_OK;
    if (type == 'b') {
        if (value.size() % 2) return false; std::vector<unsigned char> bytes; bytes.reserve(value.size() / 2);
        for (size_t i = 0; i < value.size(); i += 2) { char* p = nullptr; const auto n = std::strtoul(value.substr(i, 2).c_str(), &p, 16); if (!p || *p) return false; bytes.push_back(static_cast<unsigned char>(n)); }
        return sqlite3_bind_blob(st, index, bytes.data(), static_cast<int>(bytes.size()), SQLITE_TRANSIENT) == SQLITE_OK;
    }
    return false;
}
std::vector<std::string> split_tab(const std::string& line) {
    std::vector<std::string> values; size_t start = 0;
    while (true) { const auto end = line.find('\t', start); values.push_back(line.substr(start, end == std::string::npos ? end : end - start)); if (end == std::string::npos) break; start = end + 1; }
    return values;
}
std::string media_schema_summary(sqlite3* db) {
    if (!db) return "{}";
    std::string voice;
    for (const auto& table : message_tables(db)) {
        const auto cols = columns(db, table);
        if (choose_column(cols, {"voice_data", "voiceData"}).empty()) continue;
        voice = table; break;
    }
    if (voice.empty()) return "{}";
    const auto cols = columns(db, voice);
    const auto pick = [&](std::initializer_list<const char*> names) { return choose_column(cols, names); };
    std::string name2id;
    for (const auto& table : message_tables(db)) { if (_stricmp(table.c_str(), "Name2Id") == 0 || _stricmp(table.c_str(), "name2id") == 0) { name2id = table; break; } }
    return "{\"voice_table\":\"" + esc(reinterpret_cast<const unsigned char*>(voice.c_str())) +
        "\",\"data_col\":\"" + esc(reinterpret_cast<const unsigned char*>(pick({"voice_data", "voiceData"}).c_str())) +
        "\",\"chat_name_id_col\":\"" + esc(reinterpret_cast<const unsigned char*>(pick({"chat_name_id", "chatNameId", "chat_id"}).c_str())) +
        "\",\"time_col\":\"" + esc(reinterpret_cast<const unsigned char*>(pick({"create_time", "createTime", "time"}).c_str())) +
        "\",\"local_id_col\":\"" + esc(reinterpret_cast<const unsigned char*>(pick({"local_id", "localId"}).c_str())) +
        "\",\"svr_id_col\":\"" + esc(reinterpret_cast<const unsigned char*>(pick({"svr_id", "server_id", "MsgSvrID"}).c_str())) +
        "\",\"name2id_table\":\"" + esc(reinterpret_cast<const unsigned char*>(name2id.c_str())) + "\"}";
}
struct MessageRow { int64_t time = 0; int64_t id = 0; int type = 0; bool sent = false; std::string content; };
void collect_session_rows(Account* a, const std::string& sid, int32_t begin, int32_t end, std::vector<MessageRow>& rows) {
    if (!a) return;
    for (auto* db : a->messageDbs) {
        const auto table = table_for_session(db, sid.c_str()); if (table.empty()) continue;
        const auto cols = columns(db, table); const auto time = find_time_column(cols), id = choose_column(cols, {"local_id", "localId", "MsgLocalID"}), type = find_type_column(cols), content = find_content_column(cols), talker = find_talker_column(cols), send = choose_column(cols, {"computed_is_send", "is_send", "isSend"}), sender = choose_column(cols, {"sender_username", "sender_id", "real_sender_id"});
        if (time.empty()) continue;
        std::string sql = "SELECT " + ident(time.c_str()) + "," + (id.empty() ? std::string("0") : ident(id.c_str())) + "," + (type.empty() ? std::string("0") : ident(type.c_str())) + "," + (send.empty() ? std::string("NULL") : ident(send.c_str())) + "," + (content.empty() ? std::string("NULL") : ident(content.c_str())) + "," + (sender.empty() ? std::string("NULL") : ident(sender.c_str())) + " FROM " + ident(table.c_str()) + " WHERE " + session_predicate(talker, sid.c_str());
        if (begin > 0) sql += " AND " + ident(time.c_str()) + ">=" + std::to_string(begin); if (end > 0) sql += " AND " + ident(time.c_str()) + "<=" + std::to_string(end); sql += " ORDER BY " + ident(time.c_str()) + " ASC," + (id.empty() ? "rowid" : ident(id.c_str())) + " ASC";
        sqlite3_stmt* st = nullptr; if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) continue;
        while (sqlite3_step(st) == SQLITE_ROW) { MessageRow row; row.time = sqlite3_column_int64(st, 0); row.id = sqlite3_column_int64(st, 1); row.type = sqlite3_column_int(st, 2); row.sent = sqlite3_column_type(st, 3) != SQLITE_NULL && sqlite3_column_int(st, 3) != 0; row.content = column_string(st, 4); if (!row.sent && sqlite3_column_type(st, 5) != SQLITE_NULL && !a->wxid.empty()) row.sent = lower(column_string(st, 5)) == lower(a->wxid); rows.push_back(std::move(row)); }
        sqlite3_finalize(st);
    }
    std::sort(rows.begin(), rows.end(), [](const MessageRow& a, const MessageRow& b) { return a.time == b.time ? a.id < b.id : a.time < b.time; });
}
bool has_control(const std::string& value) { return std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 0x20; }); }
int export_snapshot(sqlite3* db, const char* tableName, const char* outputPath, std::string& response) {
    if (!db || !tableName || !*tableName || !outputPath || !*outputPath) { response = json_error("invalid arguments"); return -1; }
    if (has_control(tableName) || has_control(outputPath)) { response = json_error("invalid arguments"); return -1; }
    const auto cols = columns(db, tableName); if (cols.empty()) { response = json_error("table not found"); return -1; }
    std::ofstream file(outputPath, std::ios::binary | std::ios::trunc); if (!file) { response = json_error("open output failed"); return -1; }
    file << "WEFLOW_SNAPSHOT_V1\n";
    for (size_t i = 0; i < cols.size(); ++i) { if (i) file << '\t'; file << cols[i]; }
    file << '\n';
    sqlite3_stmt* st = nullptr; const auto sql = "SELECT * FROM " + ident(tableName);
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) { response = json_error(sqlite3_errmsg(db)); return -1; }
    int64_t rows = 0; int stepRc = SQLITE_DONE;
    while ((stepRc = sqlite3_step(st)) == SQLITE_ROW) {
        for (int i = 0; i < sqlite3_column_count(st); ++i) { if (i) file << '\t'; file << snapshot_value(st, i); }
        file << '\n'; ++rows;
    }
    sqlite3_finalize(st); file.flush();
    if (stepRc != SQLITE_DONE || !file) { response = json_error(stepRc == SQLITE_DONE ? "write output failed" : sqlite3_errmsg(db)); return -1; }
    response = json_success_counts(rows, static_cast<int>(cols.size())); return 0;
}
int import_snapshot(sqlite3* db, const char* tableName, const char* inputPath, const char* createTableSql, std::string& response) {
    if (!db || !tableName || !*tableName || !inputPath || !*inputPath || has_control(tableName) || has_control(inputPath)) { response = json_error("invalid arguments"); return -1; }
    std::ifstream file(inputPath, std::ios::binary); if (!file) { response = json_error("open input failed"); return -1; }
    std::string line;
    if (!std::getline(file, line) || line != "WEFLOW_SNAPSHOT_V1") { response = json_error("invalid snapshot header"); return -1; }
    if (!std::getline(file, line) || line.empty()) { response = json_error("empty snapshot"); return -1; }
    const auto snapshotCols = split_tab(line); if (snapshotCols.empty()) { response = json_error("invalid columns"); return -1; }
    for (const auto& col : snapshotCols) if (col.empty() || has_control(col)) { response = json_error("invalid columns"); return -1; }
    std::string schema = table_schema(db, tableName);
    if (schema.empty() && createTableSql && *createTableSql) {
        char* error = nullptr; if (sqlite3_exec(db, createTableSql, nullptr, nullptr, &error) != SQLITE_OK) { const std::string message = error ? error : "create table failed"; sqlite3_free(error); response = json_error(message.c_str()); return -1; }
        schema = table_schema(db, tableName);
    }
    if (schema.empty()) { response = json_error("table not found"); return -1; }
    const auto targetCols = columns(db, tableName); if (targetCols.empty()) { response = json_error("table not found"); return -1; }
    std::unordered_map<std::string, std::string> targetByLower; for (const auto& col : targetCols) targetByLower[lower(col)] = col;
    std::vector<std::string> insertCols; insertCols.reserve(snapshotCols.size());
    for (const auto& col : snapshotCols) { auto it = targetByLower.find(lower(col)); if (it == targetByLower.end()) { response = json_error("snapshot columns do not match table"); return -1; } insertCols.push_back(it->second); }
    std::string sql = "INSERT OR IGNORE INTO " + ident(tableName) + " ("; for (size_t i = 0; i < insertCols.size(); ++i) { if (i) sql += ','; sql += ident(insertCols[i].c_str()); } sql += ") VALUES ("; for (size_t i = 0; i < insertCols.size(); ++i) { if (i) sql += ','; sql += '?'; } sql += ')';
    sqlite3_stmt* st = nullptr; if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) { response = json_error(sqlite3_errmsg(db)); return -1; }
    int64_t rows = 0, inserted = 0, ignored = 0, malformed = 0; sqlite3_exec(db, "BEGIN", nullptr, nullptr, nullptr);
    while (std::getline(file, line)) {
        if (line.empty()) continue; ++rows; const auto values = split_tab(line);
        if (values.size() != insertCols.size()) { ++malformed; continue; }
        sqlite3_reset(st); sqlite3_clear_bindings(st); bool valid = true;
        for (size_t i = 0; i < values.size(); ++i) if (!parse_snapshot_value(values[i], static_cast<int>(i + 1), st)) { valid = false; break; }
        if (!valid) { ++malformed; continue; }
        const int rc = sqlite3_step(st); if (rc == SQLITE_DONE) { if (sqlite3_changes(db) > 0) ++inserted; else ++ignored; } else ++ignored;
    }
    sqlite3_finalize(st); sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
    response = "{\"success\":true,\"rows\":" + std::to_string(rows) + ",\"inserted\":" + std::to_string(inserted) + ",\"ignored\":" + std::to_string(ignored) + ",\"malformed\":" + std::to_string(malformed) + ",\"columns\":" + std::to_string(insertCols.size()) + "}";
    return 0;
}
int query(Account* a,const char* sql,void** outJson){if(!a||!a->db||!sql||!outJson)return-1;std::string j="[";bool first=true;int rc=query_db(a->db,sql,j,first);if(rc!=0)return fail(outJson,sqlite3_errmsg(a->db),rc);j+=']';out(outJson,j);return*outJson?0:-1;}
std::vector<std::string> message_tables(sqlite3* db) {
    std::vector<std::string> names;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", -1, &st, nullptr) != SQLITE_OK) return names;
    while (sqlite3_step(st) == SQLITE_ROW) { const char* n = reinterpret_cast<const char*>(sqlite3_column_text(st, 0)); if (n) names.emplace_back(n); }
    sqlite3_finalize(st);
    return names;
}
std::vector<std::string> columns(sqlite3* db, const std::string& table) {
    std::vector<std::string> names; sqlite3_stmt* st = nullptr;
    const std::string sql = "PRAGMA table_info(" + ident(table.c_str()) + ")";
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return names;
    while (sqlite3_step(st) == SQLITE_ROW) { const char* n = reinterpret_cast<const char*>(sqlite3_column_text(st, 1)); if (n) names.emplace_back(n); }
    sqlite3_finalize(st); return names;
}
std::string find_talker_column(const std::vector<std::string>& cols) {
    const char* preferred[] = {"StrTalker", "talker", "username", "session_id", "sessionId"};
    for (const char* want : preferred) for (const auto& col : cols) if (_stricmp(col.c_str(), want) == 0) return col;
    return {};
}
std::string find_time_column(const std::vector<std::string>& cols) {
    const char* preferred[] = {"CreateTime", "create_time", "createTime", "msg_time", "time"};
    for (const char* want : preferred) for (const auto& col : cols) if (_stricmp(col.c_str(), want) == 0) return col;
    return {};
}
std::string find_type_column(const std::vector<std::string>& cols) {
    const char* preferred[] = {"local_type", "localType", "type", "MsgType", "message_type"};
    for (const char* want : preferred) for (const auto& col : cols) if (_stricmp(col.c_str(), want) == 0) return col;
    return {};
}
std::string find_content_column(const std::vector<std::string>& cols) {
    const char* preferred[] = {"message_content", "messageContent", "content", "CompressContent", "compress_content"};
    for (const char* want : preferred) for (const auto& col : cols) if (_stricmp(col.c_str(), want) == 0) return col;
    return {};
}
std::string session_hash(const char* session) {
    if (!session) return {};
    unsigned char digest[EVP_MAX_MD_SIZE]{};
    unsigned int length = 0;
    if (EVP_Digest(session, std::strlen(session), digest, &length, EVP_md5(), nullptr) != 1 || length != 16) return {};
    static constexpr char digits[] = "0123456789abcdef";
    std::string result;
    for (unsigned int i = 0; i < length; ++i) { result += digits[digest[i] >> 4]; result += digits[digest[i] & 15]; }
    return result;
}
std::string session_predicate(const std::string& talker, const char* session) {
    return talker.empty() ? "1=1" : ident(talker.c_str()) + "=" + sql_text(session);
}
sqlite3* db_in_component(Account* a, const char* component) {
    if (!a) return nullptr;
    for (size_t i = 0; i < a->messagePaths.size(); ++i) if (path_has_component(a->messagePaths[i], component)) return a->messageDbs[i];
    return nullptr;
}
std::string table_for_session(sqlite3* db, const char* session) {
    if (!db || !session) return {};
    const auto hash = session_hash(session);
    if (!hash.empty()) {
        const auto tables = message_tables(db);
        const auto full = "Msg_" + hash;
        const auto shortName = "Msg_" + hash.substr(0, 16);
        for (const auto& table : tables) if (has_name(table, full.c_str()) || has_name(table, shortName.c_str())) return table;
    }
    for (const auto& table : message_tables(db)) {
        const auto cols = columns(db, table);
        if (find_time_column(cols).empty() || find_content_column(cols).empty() ||
            choose_column(cols,{"local_id","localId","MsgLocalID"}).empty()) continue;
        const auto talker = find_talker_column(cols);
        if (talker.empty()) continue;
        const auto sql = "SELECT 1 FROM " + ident(table.c_str()) + " WHERE " + ident(talker.c_str()) + "=" + sql_text(session) + " LIMIT 1";
        sqlite3_stmt* st = nullptr; int rc = sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr);
        if (rc == SQLITE_OK) rc = sqlite3_step(st);
        if (st) sqlite3_finalize(st);
        if (rc == SQLITE_ROW) return table;
    }
    return {};
}
int query_messages_ex(Account* a,const char* session,int32_t limit,int32_t offset,int32_t ascending,int32_t beginTimestamp,int32_t endTimestamp,const char* typeValue,void** outJson,int* rowCount=nullptr){
    if(!a||!outJson||!session)return-1;
    struct Row { int64_t time = 0; int64_t id = 0; std::string json; };
    std::vector<Row> rows;
    const int take = limit > 0 ? limit : 100;
    const int safeOffset = std::max(0, offset);
    const int fetchLimit = take + safeOffset;
    for(size_t dbIndex = 0; dbIndex < a->messageDbs.size(); ++dbIndex){
        auto* db = a->messageDbs[dbIndex];
        const auto table = table_for_session(db, session); if (table.empty()) continue;
        const auto cols=columns(db,table); const auto talker=find_talker_column(cols); const auto time=find_time_column(cols); const auto id=choose_column(cols,{"local_id","localId","MsgLocalID","msgLocalId"}); const auto type=find_type_column(cols);
        const auto send=choose_column(cols,{"is_send","isSend","IsSend","computed_is_send"});
        const auto sender=choose_column(cols,{"sender_username","senderUsername","real_sender_id","realSenderId","sender_id","senderId"});
        // Always expose one normalized flag. Some WeChat versions store the sender
        // under a variant column and leave is_send unset for self messages.
        std::string senderExpr;
        if (!sender.empty()) {
            senderExpr = "CAST(" + ident(sender.c_str()) + " AS TEXT)";
            const auto name2idCols = columns(db, "Name2Id");
            const auto name2idUser = choose_column(name2idCols, {"user_name", "username", "userName"});
            if (!name2idUser.empty()) {
                const auto rawSender = "CAST(" + ident(sender.c_str()) + " AS TEXT)";
                const auto mapped = "COALESCE((SELECT " + ident(name2idUser.c_str()) + " FROM \"Name2Id\" WHERE rowid=CAST(" + ident(sender.c_str()) + " AS INTEGER) LIMIT 1)," + rawSender + ")";
                senderExpr = "CASE WHEN typeof(" + ident(sender.c_str()) + ") IN ('integer','real') OR (" + rawSender + " GLOB '[0-9]*' AND " + rawSender + " NOT GLOB '*[^0-9]*') THEN " + mapped + " ELSE " + rawSender + " END";
            }
        }
        std::string sendExpr = send.empty() ? "0" : "COALESCE(" + ident(send.c_str()) + ",0)";
        if (!sender.empty() && !a->wxid.empty()) {
            sendExpr = "CASE WHEN (" + sendExpr + ")<>0 OR lower(" + senderExpr + ")=lower(" + sql_text(a->wxid.c_str()) + ") THEN 1 ELSE 0 END";
        }
        std::string sql="SELECT *,"+sendExpr+" AS _weflow_is_send";
        if (!sender.empty()) sql += "," + senderExpr + " AS _weflow_sender_username";
        sql += " FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,session);
        if (!type.empty() && typeValue && *typeValue) sql += " AND " + ident(type.c_str()) + "=" + sql_text(typeValue);
        if (!time.empty() && beginTimestamp > 0) sql += " AND " + ident(time.c_str()) + ">=" + std::to_string(beginTimestamp);
        if (!time.empty() && endTimestamp > 0) sql += " AND " + ident(time.c_str()) + "<=" + std::to_string(endTimestamp);
        if(!time.empty()) sql += " ORDER BY "+ident(time.c_str())+(ascending ? " ASC" : " DESC");
        sql += " LIMIT "+std::to_string(fetchLimit);
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) continue;
        int timeIndex = -1, idIndex = -1;
        for (int col = 0; col < sqlite3_column_count(st); ++col) {
            if (has_name(sqlite3_column_name(st, col), time.c_str())) timeIndex = col;
            if (!id.empty() && has_name(sqlite3_column_name(st, col), id.c_str())) idIndex = col;
        }
        while (sqlite3_step(st) == SQLITE_ROW) {
            Row row;
            row.time = timeIndex >= 0 ? sqlite3_column_int64(st, timeIndex) : 0;
            row.id = idIndex >= 0 ? sqlite3_column_int64(st, idIndex) : 0;
            row.json = "{";
            for (int col = 0; col < sqlite3_column_count(st); ++col) {
                if (col) row.json += ',';
                row.json += json_key(reinterpret_cast<const unsigned char*>(sqlite3_column_name(st, col))) + cell(st, col);
            }
            row.json += ",\"_db_path\":\"" + esc(reinterpret_cast<const unsigned char*>(a->messagePaths[dbIndex].c_str())) + "\",\"_table_name\":\"" + esc(reinterpret_cast<const unsigned char*>(table.c_str())) + "\"";
            row.json += '}';
            rows.push_back(std::move(row));
        }
        sqlite3_finalize(st);
    }
    std::sort(rows.begin(), rows.end(), [ascending](const Row& a, const Row& b) {
        if (a.time != b.time) return ascending ? a.time < b.time : a.time > b.time;
        return ascending ? a.id < b.id : a.id > b.id;
    });
    const size_t begin = std::min<size_t>(static_cast<size_t>(safeOffset), rows.size());
    const size_t end = std::min(rows.size(), begin + static_cast<size_t>(take));
    std::string j="[";
    for (size_t i = begin; i < end; ++i) { if (i > begin) j += ','; j += rows[i].json; }
    j += ']';
    if (rowCount) *rowCount = static_cast<int>(end - begin);
    out(outJson,j); return *outJson?0:-1;
}
int query_messages(Account* a,const char* session,int32_t limit,int32_t offset,void** outJson){ return query_messages_ex(a, session, limit, offset, 0, 0, 0, nullptr, outJson); }
bool hex(const char* text,std::vector<unsigned char>& bytes){if(!text)return false;std::string s(text);if(s.size()&1)return false;for(size_t i=0;i<s.size();i+=2){char*e=nullptr;auto n=std::strtoul(s.substr(i,2).c_str(),&e,16);if(!e||*e)return false;bytes.push_back((unsigned char)n);}return true;}
std::string xml_text(const std::string& xml, std::initializer_list<const char*> tags) { for (const char* tag : tags) { const auto open = std::string("<") + tag; const auto start = xml.find(open); if (start == std::string::npos) continue; const auto gt = xml.find('>', start); if (gt == std::string::npos) continue; const auto end = xml.find(std::string("</") + tag + ">", gt + 1); if (end != std::string::npos) return xml.substr(gt + 1, end - gt - 1); } return {}; }
std::string xml_attr(const std::string& tag, const char* name) { const auto p0 = tag.find(std::string(name) + "="); if (p0 == std::string::npos) return {}; auto p = p0 + std::strlen(name) + 1; if (p >= tag.size() || (tag[p] != '\"' && tag[p] != '\'')) return {}; const char q = tag[p++]; const auto e = tag.find(q, p); return e == std::string::npos ? std::string{} : tag.substr(p, e - p); }
struct SnsRow { std::string tid, username, content; int64_t createTime = 0; };
SnsRow read_sns_row(sqlite3_stmt* st, int tid, int content, int user, int time) { SnsRow row; row.tid = column_string(st, tid); row.content = column_string(st, content); row.username = column_string(st, user); row.createTime = sqlite3_column_int64(st, time); const auto object = xml_text(row.content, {"TimelineObject"}); const auto source = object.empty() ? row.content : object; if (row.username.empty()) row.username = xml_text(source, {"userName", "username", "user_name"}); if (row.createTime <= 0) { const auto t = xml_text(source, {"createTime", "create_time"}); row.createTime = t.empty() ? 0 : std::strtoll(t.c_str(), nullptr, 10); } return row; }
std::string sns_post_json(const SnsRow& row) { const auto object = xml_text(row.content, {"TimelineObject"}); const auto source = object.empty() ? row.content : object; const auto desc = xml_text(source, {"contentDesc", "ContentDesc", "content_desc"}); const auto type = xml_text(source, {"type", "Type"}); return "{\"tid\":\""+esc(reinterpret_cast<const unsigned char*>(row.tid.c_str()))+"\",\"id\":\""+esc(reinterpret_cast<const unsigned char*>(row.tid.c_str()))+"\",\"username\":\""+esc(reinterpret_cast<const unsigned char*>(row.username.c_str()))+"\",\"nickname\":\"\",\"createTime\":"+std::to_string(row.createTime)+",\"contentDesc\":\""+esc(reinterpret_cast<const unsigned char*>(desc.c_str()))+"\",\"type\":"+(type.empty()?"0":type)+",\"media\":[],\"likes\":[],\"comments\":[],\"rawXml\":\""+esc(reinterpret_cast<const unsigned char*>(row.content.c_str()))+"\"}"; }
std::vector<SnsRow> read_sns_rows(Account* a, int32_t begin, int32_t end, const char* usernames, const char* keyword, int32_t limit, int32_t offset, bool ascending) { auto* db = db_in_component(a, "sns"); if (!db) return {}; const auto table = [&] { for (const auto& n : message_tables(db)) if (_stricmp(n.c_str(), "SnsTimeLine") == 0) return n; return std::string{}; }(); if (table.empty()) return {}; const auto cols = columns(db, table); const auto tid = choose_column(cols, {"tid", "id"}); const auto content = choose_column(cols, {"content", "content_desc"}); const auto user = choose_column(cols, {"user_name", "userName", "username"}); const auto time = choose_column(cols, {"createTime", "create_time", "time"}); if (content.empty()) return {}; std::string sql="SELECT "+(tid.empty()?"''":ident(tid.c_str()))+","+ident(content.c_str())+","+(user.empty()?"''":ident(user.c_str()))+","+(time.empty()?"0":ident(time.c_str()))+" FROM "+ident(table.c_str())+" WHERE 1=1"; const auto ids=json_strings(usernames); if (!ids.empty()&&!user.empty()) { sql += " AND "+ident(user.c_str())+" IN ("; for(size_t i=0;i<ids.size();++i){if(i)sql+=',';sql+=sql_text(ids[i].c_str());} sql+=')'; } if(begin>0&&!time.empty())sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin); if(end>0&&!time.empty())sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end); sql+=" ORDER BY "+(time.empty()?"rowid":ident(time.c_str()))+(ascending?" ASC":" DESC")+" LIMIT "+std::to_string(limit>0?limit:20)+" OFFSET "+std::to_string(std::max(0,offset)); sqlite3_stmt* st=nullptr; if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return {}; std::vector<SnsRow> rows; while(sqlite3_step(st)==SQLITE_ROW){auto row=read_sns_row(st,0,1,2,3); if(keyword&&*keyword&&row.content.find(keyword)==std::string::npos)continue; rows.push_back(std::move(row));} sqlite3_finalize(st); return rows; }
std::string json_field(const char* json, const char* key) { if (!json || !key) return {}; const std::string needle = std::string("\"") + key + "\""; auto p = std::string(json).find(needle); if (p == std::string::npos) return {}; p = std::string(json).find(':', p + needle.size()); if (p == std::string::npos) return {}; ++p; while (p < std::strlen(json) && std::isspace(static_cast<unsigned char>(json[p]))) ++p; if (p < std::strlen(json) && json[p] == '\"') { ++p; const auto e = std::string(json).find('\"', p); return e == std::string::npos ? std::string{} : std::string(json).substr(p, e - p); } const auto e = std::string(json).find_first_of(",}", p); return std::string(json).substr(p, e == std::string::npos ? std::strlen(json) - p : e - p); }
std::vector<std::string> json_field_strings(const char* json, const char* key) { if (!json || !key) return {}; const std::string needle = std::string("\"") + key + "\""; auto p = std::string(json).find(needle); if (p == std::string::npos) return {}; p = std::string(json).find('[', p + needle.size()); if (p == std::string::npos) return {}; const auto e = std::string(json).find(']', p); return e == std::string::npos ? std::vector<std::string>{} : json_strings(std::string(json).substr(p, e - p + 1).c_str()); }
int64_t json_i64(const char* json, const char* key) { const auto value = json_field(json, key); if (value.empty()) return 0; char* end = nullptr; const auto n = std::strtoll(value.c_str(), &end, 10); return end && *end == 0 ? n : 0; }
bool text_has_self(const std::string& source, const std::string& self) { if (source.empty() || self.empty()) return false; auto s = lower(source), id = lower(self); return s.find("atuserlist") != std::string::npos && s.find(id) != std::string::npos; }
struct FootRow { int64_t time=0,id=0; bool sent=false; std::string content,source,sender; };
void collect_foot_rows(Account* a, const std::string& sid, int32_t begin, int32_t end, std::vector<FootRow>& rows) {
    if (!a) return; for (auto* db : a->messageDbs) { auto table=table_for_session(db,sid.c_str()); if(table.empty()) continue; auto cols=columns(db,table); auto time=find_time_column(cols), id=choose_column(cols,{"local_id","localId","MsgLocalID"}), content=find_content_column(cols), talker=find_talker_column(cols), send=choose_column(cols,{"computed_is_send","is_send","isSend"}), sender=choose_column(cols,{"sender_username","senderUsername","sender_id","real_sender_id"}), source=choose_column(cols,{"source","msg_source","message_source","MsgSource"}); if(time.empty()) continue; std::string sql="SELECT "+ident(time.c_str())+","+(id.empty()?"0":ident(id.c_str()))+","+(content.empty()?"NULL":ident(content.c_str()))+","+(send.empty()?"NULL":ident(send.c_str()))+","+(sender.empty()?"NULL":ident(sender.c_str()))+","+(source.empty()?"NULL":ident(source.c_str()))+" FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,sid.c_str()); if(begin>0)sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin); if(end>0)sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end); sql+=" ORDER BY "+ident(time.c_str())+" ASC"; sqlite3_stmt* st=nullptr; if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK) continue; while(sqlite3_step(st)==SQLITE_ROW){FootRow r; r.time=sqlite3_column_int64(st,0);r.id=sqlite3_column_int64(st,1);r.content=column_string(st,2);r.sent=sqlite3_column_type(st,3)!=SQLITE_NULL&&sqlite3_column_int(st,3)!=0;r.sender=column_string(st,4);r.source=column_string(st,5);if(!r.sent&&!a->wxid.empty()&&!r.sender.empty())r.sent=lower(r.sender)==lower(a->wxid);rows.push_back(std::move(r));}sqlite3_finalize(st);break; }
}
std::string footprint_json(Account* a, const char* options) {
    const int32_t begin = static_cast<int32_t>(std::max<int64_t>(0, json_i64(options, "begin")));
    const int32_t end = static_cast<int32_t>(std::max<int64_t>(0, json_i64(options, "end")));
    const auto myWxid = json_field(options, "my_wxid");
    auto privateIds = json_field_strings(options, "private_session_ids");
    auto groupIds = json_field_strings(options, "group_session_ids");
    const int mentionLimit = static_cast<int>(std::max<int64_t>(0, json_i64(options, "mention_limit")));
    const int privateLimit = static_cast<int>(std::max<int64_t>(0, json_i64(options, "private_limit")));
    std::vector<FootRow> privateRows; std::vector<FootRow> groupRows;
    std::unordered_map<std::string, std::vector<FootRow>> privateBySession;
    for (const auto& sid : privateIds) { std::vector<FootRow> rows; collect_foot_rows(a, sid, begin, end, rows); privateBySession[sid] = rows; }
    std::unordered_map<std::string, std::vector<FootRow>> groupBySession;
    for (const auto& sid : groupIds) { std::vector<FootRow> rows; collect_foot_rows(a, sid, begin, end, rows); groupBySession[sid] = rows; }
    std::string privateJson="["; bool first=true; int inboundPeople=0, repliedPeople=0, outboundPeople=0;
    for (const auto& [sid, rows] : privateBySession) {
        int incoming=0, outgoing=0; int64_t firstIn=0, firstReply=0, latest=0, anchorId=0, anchorTime=0;
        for (const auto& r : rows) { if (!anchorTime && r.time) { anchorTime=r.time; anchorId=r.id; } latest=std::max(latest,r.time); if (r.sent) { ++outgoing; if (firstIn && !firstReply && r.time>=firstIn) firstReply=r.time; } else { ++incoming; if (!firstIn || (r.time && r.time<firstIn)) firstIn=r.time; } }
        if (incoming) ++inboundPeople; if (outgoing) ++outboundPeople; if (incoming&&outgoing) ++repliedPeople;
        if (!incoming && !outgoing) continue;
        if (!first) privateJson+=','; first=false;
        privateJson += "{\"session_id\":\""+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\",\"incoming_count\":"+std::to_string(incoming)+",\"outgoing_count\":"+std::to_string(outgoing)+",\"replied\":"+(incoming&&outgoing?"true":"false")+",\"first_incoming_ts\":"+std::to_string(firstIn)+",\"first_reply_ts\":"+std::to_string(firstReply)+",\"latest_ts\":"+std::to_string(latest)+",\"anchor_local_id\":"+std::to_string(anchorId)+",\"anchor_create_time\":"+std::to_string(anchorTime)+"}";
    }
    privateJson += "]";
    std::unordered_map<std::string,int64_t> mentionCounts, mentionLatest; std::vector<std::pair<std::string,FootRow>> mentions;
    for (const auto& [sid, rows] : groupBySession) for (const auto& r : rows) if (text_has_self(r.source, myWxid) || (r.content.find('@') != std::string::npos && text_has_self(r.content, myWxid))) { mentionCounts[sid]++; mentionLatest[sid]=std::max(mentionLatest[sid],r.time); mentions.emplace_back(sid,r); }
    std::sort(mentions.begin(), mentions.end(), [](const auto&a,const auto&b){return a.second.time>b.second.time;});
    if (mentionLimit>0 && static_cast<int>(mentions.size())>mentionLimit) mentions.resize(mentionLimit);
    std::string mentionsJson="["; first=true; for (const auto& item:mentions) { const auto& sid=item.first; const auto& r=item.second; if(!first)mentionsJson+=','; first=false; mentionsJson+="{\"session_id\":\""+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\",\"local_id\":"+std::to_string(r.id)+",\"create_time\":"+std::to_string(r.time)+",\"sender_username\":\""+esc(reinterpret_cast<const unsigned char*>(r.sender.c_str()))+"\",\"message_content\":\""+esc(reinterpret_cast<const unsigned char*>(r.content.c_str()))+"\",\"source\":\""+esc(reinterpret_cast<const unsigned char*>(r.source.c_str()))+"\"}"; }
    mentionsJson += "]";
    std::string groupsJson="["; first=true; for(const auto&[sid,count]:mentionCounts){if(!first)groupsJson+=',';first=false;groupsJson+="{\"session_id\":\""+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\",\"count\":"+std::to_string(count)+",\"latest_ts\":"+std::to_string(mentionLatest[sid])+"}";} groupsJson+="]";
    const int privatePeople = inboundPeople; const double rate = privatePeople ? static_cast<double>(repliedPeople)/privatePeople : 0.0;
    return "{\"summary\":{\"private_inbound_people\":"+std::to_string(inboundPeople)+",\"private_replied_people\":"+std::to_string(repliedPeople)+",\"private_outbound_people\":"+std::to_string(outboundPeople)+",\"private_reply_rate\":"+std::to_string(rate)+",\"mention_count\":"+std::to_string(mentions.size())+",\"mention_group_count\":"+std::to_string(mentionCounts.size())+"},\"private_sessions\":"+privateJson+",\"private_segments\":[],\"mentions\":"+mentionsJson+",\"mention_groups\":"+groupsJson+",\"diagnostics\":{\"truncated\":false,\"scanned_dbs\":"+std::to_string(a ? a->messageDbs.size() : 0)+",\"elapsed_ms\":0,\"mention_truncated\":false,\"private_truncated\":"+(privateLimit>0?"true":"false")+"}}";
}
}
WF_EXPORT int32_t InitProtection(const char*){return 0;}
WF_EXPORT int32_t wcdb_init(){return 0;}
WF_EXPORT int32_t wcdb_shutdown(){std::lock_guard<std::mutex> lock(mu);for(auto&p:accounts)close_dbs(p.second.get());accounts.clear();cursors.clear();return 0;}
WF_EXPORT int32_t wcdb_purge_memory(){return 0;}
WF_EXPORT void wcdb_free_string(void*p){std::free(p);}
WF_EXPORT int32_t wcdb_open_account(const char*path,const char*key,int64_t*outHandle){if(!path||!key||!outHandle)return-1;*outHandle=0;auto a=std::make_unique<Account>();int rc=sqlite3_open_v2(path,&a->db,SQLITE_OPEN_READWRITE,nullptr);if(rc!=SQLITE_OK){if(a->db)sqlite3_close(a->db);return rc;}std::vector<unsigned char>b;if(!hex(key,b)||b.empty()||sqlite3_key(a->db,b.data(),(int)b.size())!=SQLITE_OK){sqlite3_close(a->db);return-2;}sqlite3_stmt*st=nullptr;rc=sqlite3_prepare_v2(a->db,"SELECT count(*) FROM sqlite_master",-1,&st,nullptr);if(rc==SQLITE_OK)rc=sqlite3_step(st);if(st)sqlite3_finalize(st);if(rc!=SQLITE_ROW&&rc!=SQLITE_DONE){sqlite3_close(a->db);return-3;}open_message_dbs(a.get(),std::filesystem::path(path),b);std::lock_guard<std::mutex>lock(mu);int64_t h=nextHandle++;accounts.emplace(h,std::move(a));*outHandle=h;return 0;}
WF_EXPORT int32_t wcdb_close_account(int64_t h){std::lock_guard<std::mutex>lock(mu);auto it=accounts.find(h);if(it==accounts.end())return-1;close_dbs(it->second.get());accounts.erase(it);return 0;}
WF_EXPORT int32_t wcdb_set_my_wxid(int64_t h,const char*wxid){auto*a=get(h);if(!a)return-1;a->wxid=wxid?wxid:"";return 0;}
WF_EXPORT int32_t wcdb_exec_query(int64_t h,const char*kind,const char*path,const char*sql,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;sqlite3*db=database_for(a,kind,path);if(!db)return fail(outJson,"database not found");if(db==a->db)return query(a,sql,outJson);std::string j="[";bool first=true;int rc=query_db(db,sql,j,first);if(rc!=0)return fail(outJson,sqlite3_errmsg(db),rc);j+=']';out(outJson,j);return*outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_sessions(int64_t h,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;auto name=table_name(a);if(name.empty()){out(outJson,"[]");return 0;}std::string sql="SELECT * FROM \""+name+"\"";return query(a,sql.c_str(),outJson);}
WF_EXPORT int32_t wcdb_get_messages(int64_t h,const char*session,int32_t limit,int32_t offset,void**outJson){return query_messages(get(h),session,limit,offset,outJson);}
WF_EXPORT int32_t wcdb_get_message_by_svrid(int64_t h,const char*session,const char*svrid,void**o){if(!o||!get(h)||!session||!svrid)return-1;auto*a=get(h);for(auto*db:a->messageDbs){auto t=table_for_session(db,session);if(t.empty())continue;auto cols=columns(db,t);auto talker=find_talker_column(cols);auto id=choose_column(cols,{"MsgSvrID","svr_id","server_id","msgSvrId"});if(id.empty())continue;auto sql="SELECT * FROM "+ident(t.c_str())+" WHERE "+session_predicate(talker,session)+" AND "+ident(id.c_str())+"="+sql_text(svrid)+" LIMIT 1";std::string j="[";bool first=true;if(query_db(db,sql.c_str(),j,first)==0){j+=']';if(j.size()>2){j.erase(0,1);j.pop_back();out(o,j);return 0;}}}out(o,"{}");return 0;}
WF_EXPORT int32_t wcdb_get_message_by_id(int64_t h,const char*session,int32_t localId,void**o){if(!o||!get(h)||!session)return-1;auto*a=get(h);for(auto*db:a->messageDbs){auto t=table_for_session(db,session);if(t.empty())continue;auto cols=columns(db,t);auto talker=find_talker_column(cols);auto id=choose_column(cols,{"local_id","localId","MsgLocalID","msgLocalId"});if(id.empty())continue;auto sql="SELECT * FROM "+ident(t.c_str())+" WHERE "+session_predicate(talker,session)+" AND "+ident(id.c_str())+"="+std::to_string(localId)+" LIMIT 1";std::string j="[";bool first=true;if(query_db(db,sql.c_str(),j,first)==0){j+=']';if(j.size()>2){j.erase(0,1);j.pop_back();out(o,j);return 0;}}}out(o,"{}");return 0;}
WF_EXPORT int32_t wcdb_get_message_count(int64_t h,const char*session,int32_t*count){if(!session||!count)return-1;auto*a=get(h);if(!a)return-1;*count=0;for(auto*db:a->messageDbs){const auto table=table_for_session(db,session);if(table.empty())continue;const auto talker=find_talker_column(columns(db,table));const auto sql="SELECT count(*) FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,session);sqlite3_stmt*st=nullptr;int rc=sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr);if(rc==SQLITE_OK)rc=sqlite3_step(st);if(rc==SQLITE_ROW)*count+=sqlite3_column_int(st,0);if(st)sqlite3_finalize(st);}return 0;}
std::string string_array(const std::vector<std::string>& values) { std::string j="["; for(size_t i=0;i<values.size();++i){if(i)j+=',';j+='"'+esc(reinterpret_cast<const unsigned char*>(values[i].c_str()))+'"';} return j+']'; }
std::string db_paths_by_kind(Account* a,const char*kind){std::vector<std::string> paths;for(const auto&path:a->messagePaths){const bool match=_stricmp(kind,"media")==0?is_media_db_path(path):_stricmp(kind,"message")==0?is_message_db_path(path):path_has_component(path,kind);if(match)paths.push_back(path);}return string_array(paths);}
WF_EXPORT int32_t wcdb_list_message_dbs(int64_t h,void**o){auto*a=get(h);if(!a||!o)return-1;out(o,db_paths_by_kind(a,"message"));return *o?0:-1;}
WF_EXPORT int32_t wcdb_list_media_dbs(int64_t h,void**o){auto*a=get(h);if(!a||!o)return-1;out(o,db_paths_by_kind(a,"media"));return *o?0:-1;}
#define EMPTY_JSON(name, sig) WF_EXPORT int32_t name sig { return fail(outJson,"not implemented"); }
WF_EXPORT int32_t wcdb_get_display_names(int64_t h,const char* ids,void**o){if(!o||!get(h))return-1;out(o,contact_value_map(get(h),ids,"display"));return 0;}
WF_EXPORT int32_t wcdb_get_avatar_urls(int64_t h,const char* ids,void**o){if(!o||!get(h))return-1;out(o,contact_value_map(get(h),ids,"avatar"));return 0;}
WF_EXPORT int32_t wcdb_get_contacts_compact(int64_t h,const char* ids,void**o){if(!o||!get(h))return-1;out(o,contact_rows(get(h),ids));return 0;}
WF_EXPORT int32_t wcdb_get_contact_status(int64_t h,const char*ids,void**o){if(!o||!get(h))return-1;auto*db=db_in_component(get(h),"contact");if(!db){out(o,"{}");return 0;}auto table=contact_table(db);auto cols=columns(db,table);auto user=choose_column(cols,{"username","user_name","userName"});auto flag=choose_column(cols,{"flag","contact_flag"});std::string j="{";bool first=true;for(const auto&id:json_strings(ids)){std::string value="{\"isFolded\":false,\"isMuted\":false}";if(!user.empty()&&!flag.empty()){auto sql="SELECT "+ident(flag.c_str())+" FROM "+ident(table.c_str())+" WHERE "+ident(user.c_str())+"="+sql_text(id.c_str())+" LIMIT 1";sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_ROW){int f=sqlite3_column_int(st,0);value="{\"isFolded\":"+std::string((f&0x20)?"true":"false")+",\"isMuted\":"+std::string((f&0x40)?"true":"false")+"}";}if(st)sqlite3_finalize(st);}if(!first)j+=',';first=false;j+='"'+esc(reinterpret_cast<const unsigned char*>(id.c_str()))+"\":"+value;}out(o,j+"}");return 0;}
WF_EXPORT int32_t wcdb_get_contact_alias_map(int64_t h,const char* ids,void**o){if(!o||!get(h))return-1;out(o,contact_value_map(get(h),ids,"alias"));return 0;}
WF_EXPORT int32_t wcdb_get_contact_friend_flags(int64_t h,const char* ids,void**o){if(!o||!get(h))return-1;out(o,contact_value_map(get(h),ids,"friend"));return 0;}
WF_EXPORT int32_t wcdb_get_group_members(int64_t h,const char*room,void**o){auto*a=get(h);if(!o||!a||!room)return-1;auto*db=db_in_component(a,"contact");if(!db)return-1;out(o,query_rows_limited(db,"SELECT c.*"+group_member_sql(room)));return *o?0:-1;}
WF_EXPORT int32_t wcdb_get_message_tables(int64_t h,const char* session,void**o){if(!o||!get(h))return-1;std::string j="[";bool first=true;auto*a=get(h);for(size_t i=0;i<a->messageDbs.size();++i){auto*db=a->messageDbs[i];auto t=table_for_session(db,session);if(t.empty())continue;auto p=a->messagePaths[i];int count=0;auto cols=columns(db,t);auto talker=find_talker_column(cols);auto sql="SELECT count(*) FROM "+ident(t.c_str())+" WHERE "+session_predicate(talker,session);sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_ROW)count=sqlite3_column_int(st,0);if(st)sqlite3_finalize(st);if(!first)j+=',';first=false;j+="{\"db_path\":\""+esc(reinterpret_cast<const unsigned char*>(p.c_str()))+"\",\"table_name\":\""+esc(reinterpret_cast<const unsigned char*>(t.c_str()))+"\",\"count\":"+std::to_string(count)+"}";break;}out(o,j+"]");return 0;}
WF_EXPORT int32_t wcdb_get_contact(int64_t h,const char* id,void**o){if(!o||!get(h))return-1;auto rows=contact_rows(get(h),(std::string("[\"")+ (id?id:"") + "\"]").c_str());if(rows.size()>2){auto pos=rows.find('}');out(o,rows.substr(0,pos+1));}else out(o,"{}");return 0;}
WF_EXPORT int32_t wcdb_get_message_table_stats(int64_t h,const char* session,void**o){if(!o||!get(h))return-1;std::string j="[";bool first=true;auto*a=get(h);for(size_t i=0;i<a->messageDbs.size();++i){auto*db=a->messageDbs[i];auto t=table_for_session(db,session);if(t.empty())continue;auto cols=columns(db,t);auto talker=find_talker_column(cols);auto time=find_time_column(cols);std::string sql="SELECT count(*)";if(!time.empty())sql+=",min("+ident(time.c_str())+"),max("+ident(time.c_str())+")";sql+=" FROM "+ident(t.c_str())+" WHERE "+session_predicate(talker,session);sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)continue;if(sqlite3_step(st)==SQLITE_ROW){if(!first)j+=',';first=false;j+="{\"db_path\":\""+esc(reinterpret_cast<const unsigned char*>(a->messagePaths[i].c_str()))+"\",\"table_name\":\""+esc(reinterpret_cast<const unsigned char*>(t.c_str()))+"\",\"count\":"+std::to_string(sqlite3_column_int(st,0));if(!time.empty())j+=",\"first_timestamp\":"+std::to_string(sqlite3_column_int(st,1))+",\"last_timestamp\":"+std::to_string(sqlite3_column_int(st,2));j+='}';}sqlite3_finalize(st);}out(o,j+"]");return 0;}
WF_EXPORT int32_t wcdb_get_aggregate_stats(int64_t h,const char* idsJson,int32_t begin,int32_t end,void**o){
    auto*a=get(h);if(!o||!a)return-1;
    std::unordered_map<std::string,int64_t> daily,sentDaily,monthly,hourly,weekday,types;
    std::string sessions="{";bool firstSession=true;int64_t total=0,totalSent=0,totalReceived=0,firstTime=0,lastTime=0;
    for(const auto&sid:json_strings(idsJson)){
        int64_t sent=0,received=0,sessionLast=0;
        std::unordered_map<std::string,int64_t> sessionMonthly;
        for(size_t index=0;index<a->messageDbs.size();++index){
            if(!is_message_db_path(a->messagePaths[index]))continue;
            auto*db=a->messageDbs[index];const auto table=table_for_session(db,sid.c_str());if(table.empty())continue;
            const auto cols=columns(db,table);
            const auto time=find_time_column(cols),talker=find_talker_column(cols);
            if(time.empty())continue;
            const auto sender=choose_column(cols,{"real_sender_id","sender_id","sender_username"});
            const auto isSend=choose_column(cols,{"computed_is_send","is_send","isSend"});
            const auto type=find_type_column(cols);
            std::string sql="SELECT "+ident(time.c_str())+","+(sender.empty()?"NULL":ident(sender.c_str()))+","+(isSend.empty()?"NULL":ident(isSend.c_str()))+","+(type.empty()?"NULL":ident(type.c_str()))+" FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,sid.c_str());
            if(begin>0)sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin);
            if(end>0)sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end);
            sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
            sqlite3_stmt*nameStmt=nullptr;
            if(!sender.empty()&&!a->wxid.empty()&&!columns(db,"Name2Id").empty())sqlite3_prepare_v2(db,"SELECT user_name FROM Name2Id WHERE rowid=? LIMIT 1",-1,&nameStmt,nullptr);
            while(sqlite3_step(st)==SQLITE_ROW){
                const int64_t rawTime=sqlite3_column_int64(st,0);
                const time_t timestamp=static_cast<time_t>(rawTime);
                tm local{};if(localtime_s(&local,&timestamp)!=0)continue;
                char day[16]{};std::strftime(day,sizeof(day),"%Y-%m-%d",&local);
                char month[8]{};std::strftime(month,sizeof(month),"%Y-%m",&local);
                ++daily[day];++monthly[month];++sessionMonthly[std::to_string(local.tm_mon+1)];
                ++hourly[std::to_string(local.tm_hour)];++weekday[std::to_string(local.tm_wday)];
                if(sqlite3_column_type(st,3)!=SQLITE_NULL)++types[column_string(st,3)];
                ++total;if(firstTime==0||rawTime<firstTime)firstTime=rawTime;
                if(rawTime>lastTime)lastTime=rawTime;if(rawTime>sessionLast)sessionLast=rawTime;
                bool mine=sqlite3_column_type(st,2)!=SQLITE_NULL&&sqlite3_column_int(st,2)==1;
                if(sqlite3_column_type(st,2)==SQLITE_NULL&&!a->wxid.empty()&&sqlite3_column_type(st,1)!=SQLITE_NULL){
                    std::string username=column_string(st,1);
                    if(nameStmt&&sqlite3_column_type(st,1)==SQLITE_INTEGER){sqlite3_reset(nameStmt);sqlite3_clear_bindings(nameStmt);sqlite3_bind_int64(nameStmt,1,sqlite3_column_int64(st,1));if(sqlite3_step(nameStmt)==SQLITE_ROW)username=column_string(nameStmt,0);}
                    mine=lower(username)==lower(a->wxid);
                }
                if(mine){++sent;++totalSent;++sentDaily[day];}else{++received;++totalReceived;}
            }
            if(nameStmt)sqlite3_finalize(nameStmt);
            sqlite3_finalize(st);
        }
        if(!firstSession)sessions+=',';firstSession=false;
        sessions+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":{\"total\":"+std::to_string(sent+received)+",\"totalMessages\":"+std::to_string(sent+received)+",\"sent\":"+std::to_string(sent)+",\"received\":"+std::to_string(received)+",\"lastTime\":"+std::to_string(sessionLast)+",\"monthly\":{";
        bool firstMonth=true;for(const auto&[month,count]:sessionMonthly){if(!firstMonth)sessions+=',';firstMonth=false;sessions+='"'+month+"\":"+std::to_string(count);}sessions+="}}";
    }
    sessions+='}';
    auto numberMap=[](const std::unordered_map<std::string,int64_t>&items){std::string json="{";bool first=true;for(const auto&[key,value]:items){if(!first)json+=',';first=false;json+='"'+esc(reinterpret_cast<const unsigned char*>(key.c_str()))+"\":"+std::to_string(value);}return json+'}';};
    const std::string json="{\"total\":"+std::to_string(total)+",\"sent\":"+std::to_string(totalSent)+",\"received\":"+std::to_string(totalReceived)+",\"firstTime\":"+std::to_string(firstTime)+",\"lastTime\":"+std::to_string(lastTime)+",\"sessions\":"+sessions+",\"daily\":"+numberMap(daily)+",\"sentDaily\":"+numberMap(sentDaily)+",\"monthly\":"+numberMap(monthly)+",\"hourly\":"+numberMap(hourly)+",\"weekday\":"+numberMap(weekday)+",\"typeCounts\":"+numberMap(types)+",\"idMap\":{}}";
    out(o,json);return *o?0:-1;
}
WF_EXPORT int32_t wcdb_get_available_years(int64_t h,const char*idsJson,void**o){if(!o||!get(h))return-1;auto ids=json_strings(idsJson);std::vector<int> years;auto*a=get(h);for(const auto&sid:ids)for(auto*db:a->messageDbs){auto t=table_for_session(db,sid.c_str());if(t.empty())continue;auto cols=columns(db,t);auto talker=find_talker_column(cols);auto time=find_time_column(cols);if(time.empty())continue;auto sql="SELECT "+ident(time.c_str())+" FROM "+ident(t.c_str())+" WHERE "+session_predicate(talker,sid.c_str());sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK)while(sqlite3_step(st)==SQLITE_ROW){time_t ts=sqlite3_column_int64(st,0);tm tmv{};localtime_s(&tmv,&ts);years.push_back(tmv.tm_year+1900);}if(st)sqlite3_finalize(st);}std::sort(years.begin(),years.end());years.erase(std::unique(years.begin(),years.end()),years.end());std::string j="[";for(size_t i=0;i<years.size();++i){if(i)j+=',';j+=std::to_string(years[i]);}out(o,j+"]");return 0;}
WF_EXPORT int32_t wcdb_get_annual_report_stats(int64_t h,const char*ids,int32_t begin,int32_t end,void**outJson){return wcdb_get_aggregate_stats(h,ids,begin,end,outJson);}
WF_EXPORT int32_t wcdb_get_annual_report_extras(int64_t h,const char*ids,int32_t begin,int32_t end,int32_t peakBegin,int32_t peakEnd,void**outJson){
    auto*a=get(h);if(!a||!ids||!outJson)return-1;std::unordered_map<std::string,int64_t> midnight,peak;std::unordered_map<std::string,std::array<int64_t,24>> heat;std::unordered_map<std::string,std::pair<int64_t,int64_t>> conversation;std::unordered_map<std::string,std::vector<std::string>> days;std::unordered_map<std::string,int64_t> phrases;
    for(const auto&sid:json_strings(ids)){std::vector<MessageRow> rows;collect_session_rows(a,sid,begin,end,rows);int64_t last=0;bool lastSent=false;std::set<std::string> daySet;
        for(const auto&row:rows){time_t tt=static_cast<time_t>(row.time);tm local{};if(localtime_s(&local,&tt)!=0)continue;char day[16]{},monthDay[16]{};std::strftime(day,sizeof(day),"%Y-%m-%d",&local);std::strftime(monthDay,sizeof(monthDay),"%m-%d",&local);daySet.insert(day);heat[sid][local.tm_hour]++;if(local.tm_hour<6)midnight[sid]++;if(peakBegin>0&&row.time>=peakBegin&&row.time<=peakEnd)peak[sid]++;if(!last||row.time-last>3600){row.sent?conversation[sid].first++:conversation[sid].second++;}else if(!lastSent&&row.sent)conversation[sid].first++;last=row.time;lastSent=row.sent;if(row.sent&&row.type==1&&row.content.size()>=2&&row.content.size()<=20&&row.content.find("http")==std::string::npos)phrases[row.content]++;}
        days[sid]=std::vector<std::string>(daySet.begin(),daySet.end());
    }
    int bestStreak=0;std::string bestSid,bestStart,bestEnd;for(const auto&[sid,raw]:days){if(raw.empty())continue;int streak=1,maxStreak=1;std::string start=raw[0],maxStart=raw[0],maxEnd=raw[0];for(size_t i=1;i<raw.size();++i){const auto aDay=raw[i-1],bDay=raw[i];std::tm ta{},tb{};std::sscanf(aDay.c_str(),"%d-%d-%d",&ta.tm_year,&ta.tm_mon,&ta.tm_mday);std::sscanf(bDay.c_str(),"%d-%d-%d",&tb.tm_year,&tb.tm_mon,&tb.tm_mday);ta.tm_year-=1900;ta.tm_mon--;tb.tm_year-=1900;tb.tm_mon--;if(std::difftime(std::mktime(&tb),std::mktime(&ta))==86400)streak++;else{streak=1;start=bDay;}if(streak>maxStreak){maxStreak=streak;maxStart=start;maxEnd=bDay;}}if(maxStreak>bestStreak){bestStreak=maxStreak;bestSid=sid;bestStart=maxStart;bestEnd=maxEnd;}}
    std::string json="{\"heatmap\":{";bool first=true;for(const auto&[sid,bins]:heat){if(!first)json+=',';first=false;json+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":[";for(int i=0;i<24;++i){if(i)json+=',';json+=std::to_string(bins[i]);}json+=']';}json+="},\"midnight\":{";first=true;for(const auto&[sid,n]:midnight){if(!first)json+=',';first=false;json+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":"+std::to_string(n);}json+="},\"conversation\":{";first=true;for(const auto&[sid,p]:conversation){if(!first)json+=',';first=false;json+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":{\"initiated\":"+std::to_string(p.first)+",\"received\":"+std::to_string(p.second)+'}';}json+="},\"peakDay\":{";first=true;for(const auto&[sid,n]:peak){if(!first)json+=',';first=false;json+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":"+std::to_string(n);}json+="},\"topPhrases\":[";std::vector<std::pair<std::string,int64_t>> sorted(phrases.begin(),phrases.end());std::sort(sorted.begin(),sorted.end(),[](auto&a,auto&b){return a.second>b.second;});for(size_t i=0;i<sorted.size()&&i<50;++i){if(i)json+=',';json+="{\"phrase\":\""+esc(reinterpret_cast<const unsigned char*>(sorted[i].first.c_str()))+"\",\"count\":"+std::to_string(sorted[i].second)+'}';}json+="]";if(bestStreak>0)json+=",\"streak\":{\"sessionId\":\""+esc(reinterpret_cast<const unsigned char*>(bestSid.c_str()))+"\",\"days\":"+std::to_string(bestStreak)+",\"startDate\":\""+bestStart+"\",\"endDate\":\""+bestEnd+"\"}";json+='}';out(outJson,json);return*outJson?0:-1;
}
WF_EXPORT int32_t wcdb_get_dual_report_stats(int64_t h,const char*sid,int32_t begin,int32_t end,void**outJson){
    auto*a=get(h);if(!a||!sid||!outJson)return-1;std::vector<MessageRow> rows;collect_session_rows(a,sid,begin,end,rows);int64_t words=0,image=0,voice=0,emoji=0;std::unordered_map<std::string,int64_t> phrases,monthly;int64_t total=rows.size();std::array<int64_t,7*24> heat{};int64_t initiated=0,received=0;int64_t last=0;bool lastSent=false;std::vector<int64_t> responses;std::unordered_map<int,int64_t> emojiCounts;
    for(const auto&r:rows){words+=static_cast<int64_t>(std::count_if(r.content.begin(),r.content.end(),[](unsigned char c){return c>0x20;}));if(r.type==3)image++;if(r.type==34)voice++;if(r.type==47){emoji++;emojiCounts[r.id]++;}time_t tt=static_cast<time_t>(r.time);tm local{};localtime_s(&local,&tt);heat[(local.tm_wday==0?6:local.tm_wday-1)*24+local.tm_hour]++;char month[8]{};std::strftime(month,sizeof(month),"%Y-%m",&local);monthly[month]++;if(!last||r.time-last>3600){r.sent?initiated++:received++;}else if(!lastSent&&r.sent&&r.time-last<86400)responses.push_back(r.time-last);last=r.time;lastSent=r.sent;if(r.sent&&r.type==1&&r.content.size()>=2&&r.content.size()<=20)phrases[r.content]++;}
    double avg=0;int64_t fastest=0;for(auto n:responses){avg+=n;if(!fastest||n<fastest)fastest=n;}if(!responses.empty())avg/=responses.size();std::vector<std::pair<std::string,int64_t>> top(phrases.begin(),phrases.end());std::sort(top.begin(),top.end(),[](auto&a,auto&b){return a.second>b.second;});std::string json="{\"counts\":{\"total\":"+std::to_string(total)+",\"words\":"+std::to_string(words)+",\"image\":"+std::to_string(image)+",\"voice\":"+std::to_string(voice)+",\"emoji\":"+std::to_string(emoji)+"},\"phrases\":[";for(size_t i=0;i<top.size()&&i<50;++i){if(i)json+=',';json+="{\"phrase\":\""+esc(reinterpret_cast<const unsigned char*>(top[i].first.c_str()))+"\",\"count\":"+std::to_string(top[i].second)+'}';}json+="] ,\"myPhrases\":[],\"friendPhrases\":[],\"heatmap\":[";for(int d=0;d<7;++d){if(d)json+=',';json+='[';for(int h2=0;h2<24;++h2){if(h2)json+=',';json+=std::to_string(heat[d*24+h2]);}json+=']';}json+="] ,\"initiative\":{\"initiated\":"+std::to_string(initiated)+",\"received\":"+std::to_string(received)+"},\"response\":{\"avg\":"+std::to_string(static_cast<int64_t>(avg))+",\"fastest\":"+std::to_string(fastest)+",\"count\":"+std::to_string(responses.size())+"},\"monthly\":{";bool first=true;for(const auto&[m,n]:monthly){if(!first)json+=',';first=false;json+='"'+m+"\":"+std::to_string(n);}json+="},\"streak\":{\"days\":0,\"startDate\":\"\",\"endDate\":\"\"}}";out(outJson,json);return*outJson?0:-1;
}
WF_EXPORT int32_t wcdb_get_message_dates(int64_t h,const char*session,void**o){if(!o||!get(h)||!session)return-1;auto*a=get(h);for(auto*db:a->messageDbs){auto t=table_for_session(db,session);if(t.empty())continue;auto cols=columns(db,t);auto talker=find_talker_column(cols);auto time=find_time_column(cols);if(time.empty())continue;auto sql="SELECT DISTINCT date("+ident(time.c_str())+",'unixepoch','localtime') FROM "+ident(t.c_str())+" WHERE "+session_predicate(talker,session)+" ORDER BY 1";std::string j="[";bool first=true;sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK){while(sqlite3_step(st)==SQLITE_ROW){auto*date=sqlite3_column_text(st,0);if(!date)continue;if(!first)j+=',';first=false;j+='"'+esc(date)+'"';}}if(st)sqlite3_finalize(st);out(o,j+"]");return 0;}out(o,"[]");return 0;}
WF_EXPORT int32_t wcdb_get_db_status(int64_t h,void**o){if(!o||!get(h))return-1;auto*a=get(h);out(o,"{\"session_open\":true,\"database_count\":"+std::to_string(a->messageDbs.size()+1)+"}");return 0;}
WF_EXPORT int32_t wcdb_mark_all_sessions_read(int64_t h,void**outError){
    auto*a=get(h);if(!a||!outError)return-1;
    std::vector<std::pair<std::string,std::string>> targets;
    for(const auto&table:message_tables(a->db)){
        const auto name=lower(table);if(name!="sessiontable"&&name!="session"&&name!="sessions"&&name!="contact")continue;
        const auto cols=columns(a->db,table);const auto unread=choose_column(cols,{"unread_count","unreadCount","unread"});if(!unread.empty())targets.emplace_back(table,unread);
    }
    if(targets.empty())return fail(outError,"session table not found");
    sqlite3_exec(a->db,"BEGIN",nullptr,nullptr,nullptr);int changed=0;
    for(const auto&[table,column]:targets){const auto sql="UPDATE "+ident(table.c_str())+" SET "+ident(column.c_str())+"=0";sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(a->db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_DONE)changed+=sqlite3_changes(a->db);if(st)sqlite3_finalize(st);}
    sqlite3_exec(a->db,"COMMIT",nullptr,nullptr,nullptr);out(outError,"Success");return 0;
}
WF_EXPORT int32_t wcdb_get_group_member_count(int64_t h,const char*room,int32_t*outCount){if(!outCount)return-1;const int32_t count=group_member_count(get(h),room);if(count<0)return-1;*outCount=count;return 0;}
WF_EXPORT int32_t wcdb_open_message_cursor(int64_t h,const char*session,int32_t batchSize,int32_t ascending,int32_t beginTimestamp,int32_t endTimestamp,int64_t*outCursor){if(!outCursor||!session||!get(h))return-1;Cursor c;c.handle=h;c.session=session;c.batchSize=batchSize>0?batchSize:100;c.ascending=ascending;c.beginTimestamp=beginTimestamp;c.endTimestamp=endTimestamp;std::lock_guard<std::mutex>lock(mu);int64_t id=nextCursor++;cursors.emplace(id,std::move(c));*outCursor=id;return 0;}
WF_EXPORT int32_t wcdb_fetch_message_batch(int64_t h,int64_t id,void**outJson,int32_t*outHasMore){if(!outJson||!outHasMore)return-1;Cursor snapshot;{std::lock_guard<std::mutex>lock(mu);auto it=cursors.find(id);if(it==cursors.end()||it->second.handle!=h)return-1;snapshot=it->second;}void*raw=nullptr;int rows=0;int rc=query_messages_ex(get(h),snapshot.session.c_str(),snapshot.batchSize,snapshot.offset,snapshot.ascending,snapshot.beginTimestamp,snapshot.endTimestamp,nullptr,&raw,&rows);if(rc!=0)return rc;std::string payload=raw?static_cast<const char*>(raw):"[]";out(outJson,payload);std::free(raw);{std::lock_guard<std::mutex>lock(mu);auto it=cursors.find(id);if(it!=cursors.end()&&it->second.handle==h)it->second.offset+=rows;}*outHasMore=rows>=snapshot.batchSize;return 0;}
WF_EXPORT int32_t wcdb_close_message_cursor(int64_t h,int64_t id){std::lock_guard<std::mutex>lock(mu);auto it=cursors.find(id);if(it==cursors.end()||it->second.handle!=h)return-1;cursors.erase(it);return 0;}

// ABI-compatible fallbacks for optional WeFlow features.
#define JSON0(name, sig, param) WF_EXPORT int32_t name sig { return fail(param,"not implemented"); }
#define ERR0(name, sig, param) WF_EXPORT int32_t name sig { return fail(param, "not implemented"); }
WF_EXPORT int32_t wcdb_get_group_member_counts(int64_t h,const char*rooms,void**o){auto*a=get(h);if(!o||!a)return-1;std::string j="{";bool first=true;for(const auto&room:json_strings(rooms)){const int32_t count=group_member_count(a,room.c_str());if(count<0)return-1;if(!first)j+=',';first=false;j+='"'+esc(reinterpret_cast<const unsigned char*>(room.c_str()))+"\":"+std::to_string(count);}out(o,j+"}");return *o?0:-1;}
WF_EXPORT int32_t wcdb_get_group_nicknames(int64_t h,const char*room,void**outJson){
    auto*a=get(h);if(!a||!room||!outJson)return-1;
    auto*db=db_in_component(a,"contact");if(!db)return-2;
    sqlite3_stmt*st=nullptr;
    const auto sql="SELECT ext_buffer FROM chat_room WHERE username="+sql_text(room)+" LIMIT 1";
    if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
    std::string json="{}";
    if(sqlite3_step(st)==SQLITE_ROW)json=group_nicknames(static_cast<const unsigned char*>(sqlite3_column_blob(st,0)),static_cast<size_t>(sqlite3_column_bytes(st,0)));
    sqlite3_finalize(st);out(outJson,json);return *outJson?0:-1;
}
WF_EXPORT int32_t wcdb_get_contact_type_counts(int64_t h,void**o){
    auto*a=get(h);if(!o||!a)return-1;auto*db=db_in_component(a,"contact");if(!db)return-1;
    sqlite3_stmt*st=nullptr;
    const char*sql="SELECT username,local_type,flag,quan_pin,alias,remark FROM contact";
    if(sqlite3_prepare_v2(db,sql,-1,&st,nullptr)!=SQLITE_OK)return-1;
    int counts[5]{};
    while(sqlite3_step(st)==SQLITE_ROW){
        const auto username=column_string(st,0);
        if(username.empty())continue;
        const int type=sqlite3_column_int(st,1),flag=sqlite3_column_int(st,2);
        const bool group=username.size()>=9&&username.compare(username.size()-9,9,"@chatroom")==0;
        const bool official=username.rfind("gh_",0)==0;
        const bool former=!official&&((type==0&&!column_string(st,3).empty())||(type==3&&flag!=4&&(!column_string(st,3).empty()||!column_string(st,4).empty()||!column_string(st,5).empty())));
        if(group)++counts[1];
        else if(official&&type==1&&username!="gh_f0a92aa7146c")++counts[2];
        else if(!official&&(flag&8)==8)++counts[4];
        else if(former)++counts[3];
        else if(type==1&&(flag&8)==0&&username!="medianote"&&username!="floatbottle"&&username!="qmessage"&&username!="qqmail"&&username!="fmessage")++counts[0];
    }
    sqlite3_finalize(st);
    out(o,"{\"private\":"+std::to_string(counts[0])+",\"group\":"+std::to_string(counts[1])+",\"official\":"+std::to_string(counts[2])+",\"former_friend\":"+std::to_string(counts[3])+",\"blocked\":"+std::to_string(counts[4])+"}");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_get_chat_room_ext_buffer(int64_t h,const char*room,void**o){auto*a=get(h);if(!o||!a||!room)return-1;auto*db=db_in_component(a,"contact");if(!db)return-1;const auto sql="SELECT ext_buffer FROM chat_room WHERE username="+sql_text(room)+" LIMIT 1";sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-1;std::string value;if(sqlite3_step(st)==SQLITE_ROW){auto json=cell(st,0);if(json!="null")value=json;}sqlite3_finalize(st);out(o,"{\"ext_buffer\":"+(value.empty()?"\"\"":value)+"}");return *o?0:-1;}
WF_EXPORT int32_t wcdb_get_logs(void**outJson){if(!outJson)return-1;out(outJson,"[]");return *outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_group_stats(int64_t h,const char*room,int32_t begin,int32_t end,void**outJson){
    auto*a=get(h);if(!a||!room||!outJson)return-1;
    std::unordered_map<std::string,int64_t> senders,types;
    std::unordered_map<std::string,std::string> idMap;
    int64_t hourly[24]{};
    int64_t total=0;
    for(size_t index=0;index<a->messageDbs.size();++index){
        if(!is_message_db_path(a->messagePaths[index]))continue;
        auto*db=a->messageDbs[index];
        const auto table=table_for_session(db,room);
        if(table.empty())continue;
        const auto cols=columns(db,table);
        const auto sender=choose_column(cols,{"real_sender_id","sender_id","sender_username"});
        const auto type=find_type_column(cols),time=find_time_column(cols),talker=find_talker_column(cols);
        if(sender.empty()||type.empty()||time.empty())return-2;
        std::string sql="SELECT "+ident(sender.c_str())+","+ident(type.c_str())+","+ident(time.c_str())+" FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,room);
        if(begin>0)sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin);
        if(end>0)sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end);
        sqlite3_stmt*st=nullptr;
        if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
        while(sqlite3_step(st)==SQLITE_ROW){
            const auto senderId=column_string(st,0),typeId=column_string(st,1);
            if(!senderId.empty())++senders[senderId];
            ++types[typeId];++total;
            const time_t timestamp=static_cast<time_t>(sqlite3_column_int64(st,2));
            tm local{};if(localtime_s(&local,&timestamp)==0&&local.tm_hour>=0&&local.tm_hour<24)++hourly[local.tm_hour];
        }
        sqlite3_finalize(st);
        if(columns(db,"Name2Id").empty())continue;
        if(sqlite3_prepare_v2(db,"SELECT rowid,user_name FROM Name2Id",-1,&st,nullptr)!=SQLITE_OK)continue;
        while(sqlite3_step(st)==SQLITE_ROW){const auto id=column_string(st,0),name=column_string(st,1);if(senders.count(id)&&!name.empty())idMap[id]=name;}
        sqlite3_finalize(st);
    }
    auto numberMap=[](const std::unordered_map<std::string,int64_t>&items){std::string json="{";bool first=true;for(const auto&[key,value]:items){if(!first)json+=',';first=false;json+='"'+esc(reinterpret_cast<const unsigned char*>(key.c_str()))+"\":"+std::to_string(value);}return json+'}';};
    std::string mapJson="{";bool first=true;
    for(const auto&[id,name]:idMap){if(!first)mapJson+=',';first=false;mapJson+='"'+esc(reinterpret_cast<const unsigned char*>(id.c_str()))+"\":\""+esc(reinterpret_cast<const unsigned char*>(name.c_str()))+'"';}
    mapJson+='}';
    std::string hours="{";for(int i=0;i<24;++i){if(i)hours+=',';hours+='"'+std::to_string(i)+"\":"+std::to_string(hourly[i]);}hours+='}';
    const std::string roomId=room;
    const std::string json="{\"total\":"+std::to_string(total)+",\"sessions\":{\""+esc(reinterpret_cast<const unsigned char*>(roomId.c_str()))+"\":{\"senders\":"+numberMap(senders)+"}},\"idMap\":"+mapJson+",\"hourly\":"+hours+",\"typeCounts\":"+numberMap(types)+"}";
    out(outJson,json);return *outJson?0:-1;
}
WF_EXPORT int32_t wcdb_get_my_footprint_stats(int64_t h,const char*options,void**outJson){auto*a=get(h);if(!a||!options||!outJson)return-1;out(outJson,footprint_json(a,options));return *outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_message_meta(int64_t h,const char*dbPath,const char*table,int32_t limit,int32_t offset,void**o){if(!o||!get(h))return-1;auto*a=get(h);auto*db=database_for(a,"message",dbPath);if(dbPath&&*dbPath)db=database_for(a,"",dbPath);if(!db||!table)return-1;out(o,query_rows_limited(db,"SELECT * FROM "+ident(table)+" LIMIT "+std::to_string(limit>0?limit:100)+" OFFSET "+std::to_string(offset>0?offset:0)));return 0;}
WF_EXPORT int32_t wcdb_get_voice_data(int64_t h,const char*session,int32_t createTime,int32_t localId,int64_t svrId,const char*candidatesJson,void**outHex){
    auto*a=get(h);if(!a||!session||!outHex)return-1;
    auto candidates=json_strings(candidatesJson);candidates.push_back(session);
    for(size_t index=0;index<a->messageDbs.size();++index){
        if(!is_media_db_path(a->messagePaths[index]))continue;
        auto*db=a->messageDbs[index];
        const auto cols=columns(db,"VoiceInfo");
        if(choose_column(cols,{"voice_data"}).empty())continue;
        std::vector<int64_t> chatIds;
        sqlite3_stmt*nameStmt=nullptr;
        if(sqlite3_prepare_v2(db,"SELECT rowid FROM Name2Id WHERE user_name=? LIMIT 1",-1,&nameStmt,nullptr)==SQLITE_OK){
            for(const auto&candidate:candidates){sqlite3_reset(nameStmt);sqlite3_clear_bindings(nameStmt);sqlite3_bind_text(nameStmt,1,candidate.c_str(),-1,SQLITE_TRANSIENT);if(sqlite3_step(nameStmt)==SQLITE_ROW)chatIds.push_back(sqlite3_column_int64(nameStmt,0));}
        }
        if(nameStmt)sqlite3_finalize(nameStmt);
        auto findVoice=[&](const std::string&where,int64_t chatId)->bool{
            const auto sql="SELECT voice_data FROM VoiceInfo WHERE "+where+" LIMIT 1";
            sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return false;
            int bind=1;if(chatId>0)sqlite3_bind_int64(st,bind++,chatId);
            if(svrId>0&&where.find("svr_id")!=std::string::npos)sqlite3_bind_int64(st,bind++,svrId);
            else{if(createTime>0)sqlite3_bind_int(st,bind++,createTime);if(localId>0)sqlite3_bind_int(st,bind++,localId);}
            bool found=false;
            if(sqlite3_step(st)==SQLITE_ROW&&sqlite3_column_type(st,0)==SQLITE_BLOB){auto value=cell(st,0);out(outHex,value.substr(1,value.size()-2));found=*outHex!=nullptr;}
            sqlite3_finalize(st);return found;
        };
        if(svrId>0){
            for(auto chatId:chatIds)if(findVoice("chat_name_id=? AND svr_id=?",chatId))return 0;
            if(findVoice("svr_id=?",0))return 0;
        }
        if(createTime>0&&localId>0){
            for(auto chatId:chatIds)if(findVoice("chat_name_id=? AND create_time=? AND local_id=?",chatId))return 0;
            if(findVoice("create_time=? AND local_id=?",0))return 0;
        }
    }
    out(outHex,"");return *outHex?0:-1;
}
WF_EXPORT int32_t wcdb_get_voice_data_batch(int64_t h,const char*requests,void**o){
    auto*a=get(h);if(!a||!requests||!o)return-1;
    sqlite3_stmt*st=nullptr;
    const char*sql="SELECT json_extract(value,'$.session_id'),json_extract(value,'$.create_time'),json_extract(value,'$.local_id'),json_extract(value,'$.svr_id'),json_extract(value,'$.candidates') FROM json_each(?)";
    if(sqlite3_prepare_v2(a->db,sql,-1,&st,nullptr)!=SQLITE_OK)return-2;
    sqlite3_bind_text(st,1,requests,-1,SQLITE_TRANSIENT);
    std::string json="[";int index=0,rc;
    while((rc=sqlite3_step(st))==SQLITE_ROW){
        const auto session=column_string(st,0),svrText=column_string(st,3),candidates=column_string(st,4);
        char*end=nullptr;const int64_t svrId=std::strtoll(svrText.c_str(),&end,10);
        void*raw=nullptr;
        const int result=wcdb_get_voice_data(h,session.c_str(),sqlite3_column_int(st,1),sqlite3_column_int(st,2),end!=svrText.c_str()?svrId:0,candidates.c_str(),&raw);
        if(result!=0){if(raw)std::free(raw);sqlite3_finalize(st);return result;}
        if(index)json+=',';
        json+="{\"index\":"+std::to_string(index++)+",\"hex\":\""+esc(reinterpret_cast<const unsigned char*>(raw?raw:""))+"\"}";
        if(raw)std::free(raw);
    }
    sqlite3_finalize(st);if(rc!=SQLITE_DONE)return-2;
    out(o,json+"]");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_get_media_schema_summary(int64_t h,const char*path,void**outJson){auto*a=get(h);if(!a||!path||!outJson)return-1;auto*db=database_for(a,"media",path);if(!db)db=database_for(a,"",path);if(!db)return fail(outJson,"database not found");out(outJson,media_schema_summary(db));return *outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_session_message_counts(int64_t h,const char*ids,void**o){if(!o||!get(h))return-1;std::string j="{";bool first=true;for(const auto&sid:json_strings(ids)){int32_t n=0;wcdb_get_message_count(h,sid.c_str(),&n);if(!first)j+=',';first=false;j+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":"+std::to_string(n);}out(o,j+"}");return 0;}
WF_EXPORT int32_t wcdb_get_session_message_type_stats(int64_t h,const char*sid,int32_t begin,int32_t end,void**o){
    auto*a=get(h);if(!o||!a||!sid)return-1;
    int64_t counts[9]{};int64_t first=0,last=0;
    for(auto*db:a->messageDbs){
        auto table=table_for_session(db,sid);if(table.empty())continue;
        auto cols=columns(db,table);
        auto type=find_type_column(cols),time=find_time_column(cols),talker=find_talker_column(cols);
        if(type.empty()||time.empty())continue;
        std::string sql="SELECT "+ident(type.c_str())+",count(*),min("+ident(time.c_str())+"),max("+ident(time.c_str())+") FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,sid);
        if(begin>0)sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin);
        if(end>0)sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end);
        sql+=" GROUP BY "+ident(type.c_str());sqlite3_stmt*st=nullptr;
        if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
        while(sqlite3_step(st)==SQLITE_ROW){
            const int64_t t=sqlite3_column_int64(st,0),n=sqlite3_column_int64(st,1),lo=sqlite3_column_int64(st,2),hi=sqlite3_column_int64(st,3);
            counts[0]+=n;if(t==34)counts[1]+=n;if(t==3)counts[2]+=n;if(t==43)counts[3]+=n;if(t==47)counts[4]+=n;
            if(t==50)counts[6]+=n;if(t==8589934592049LL)counts[7]+=n;if(t==8594229559345LL)counts[8]+=n;
            if(t==34359738417LL||t==103079215153LL||t==25769803825LL)counts[5]+=n;
            if(lo>0&&(first==0||lo<first))first=lo;if(hi>last)last=hi;
        }
        sqlite3_finalize(st);
    }
    static const char* names[]={"total_messages","voice_messages","image_messages","video_messages","emoji_messages","file_messages","call_messages","transfer_messages","red_packet_messages"};
    std::string json="{";for(int i=0;i<9;++i){if(i)json+=',';json+='"'+std::string(names[i])+"\":"+std::to_string(counts[i]);}
    json+=",\"first_timestamp\":"+std::to_string(first)+",\"last_timestamp\":"+std::to_string(last)+"}";out(o,json);return *o?0:-1;
}
int32_t json_int_field(const char*source,const char*field){
    if(!source||!field)return 0;
    const std::string text(source),key="\""+std::string(field)+"\"";
    auto pos=text.find(key);if(pos==std::string::npos)return 0;
    pos=text.find(':',pos+key.size());if(pos==std::string::npos)return 0;
    const char*value=text.c_str()+pos+1;char*end=nullptr;
    const long n=std::strtol(value,&end,10);
    return end!=value&&n>0&&n<=INT32_MAX?static_cast<int32_t>(n):0;
}
WF_EXPORT int32_t wcdb_get_session_message_type_stats_batch(int64_t h,const char*ids,const char*options,void**o){
    if(!o||!get(h))return-1;
    const int32_t begin=json_int_field(options,"begin"),end=json_int_field(options,"end");
    std::string json="{";bool first=true;
    for(const auto&sid:json_strings(ids)){
        void*raw=nullptr;const int32_t rc=wcdb_get_session_message_type_stats(h,sid.c_str(),begin,end,&raw);
        if(rc!=0){if(raw)std::free(raw);return rc;}
        if(!first)json+=',';first=false;
        json+=json_key(reinterpret_cast<const unsigned char*>(sid.c_str()))+(raw?static_cast<const char*>(raw):"{}");
        if(raw)std::free(raw);
    }
    out(o,json+'}');return *o?0:-1;
}
WF_EXPORT int32_t wcdb_get_session_message_date_counts(int64_t h,const char*sid,void**o){
    auto*a=get(h);if(!o||!a||!sid)return-1;std::unordered_map<std::string,int64_t> counts;
    for(auto*db:a->messageDbs){
        auto table=table_for_session(db,sid);if(table.empty())continue;
        auto cols=columns(db,table);
        auto time=find_time_column(cols),talker=find_talker_column(cols);if(time.empty())continue;
        auto sql="SELECT date("+ident(time.c_str())+",'unixepoch','localtime'),count(*) FROM "+ident(table.c_str())+" WHERE "+session_predicate(talker,sid)+" GROUP BY 1";
        sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
        while(sqlite3_step(st)==SQLITE_ROW){const auto*day=sqlite3_column_text(st,0);if(day)counts[reinterpret_cast<const char*>(day)]+=sqlite3_column_int64(st,1);}sqlite3_finalize(st);
    }
    std::string json="{";bool first=true;for(const auto&[day,count]:counts){if(!first)json+=',';first=false;json+='"'+day+"\":"+std::to_string(count);}out(o,json+"}");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_get_session_message_date_counts_batch(int64_t h,const char*ids,void**o){if(!o||!get(h))return-1;std::string j="{";bool first=true;for(const auto&sid:json_strings(ids)){void*raw=nullptr;int rc=wcdb_get_session_message_date_counts(h,sid.c_str(),&raw);if(rc!=0)return rc;if(!first)j+=",";first=false;j+='"'+esc(reinterpret_cast<const unsigned char*>(sid.c_str()))+"\":"+(raw?static_cast<const char*>(raw):"{}");if(raw)std::free(raw);}out(o,j+"}");return *o?0:-1;}
WF_EXPORT int32_t wcdb_get_messages_by_type(int64_t h,const char*sid,int64_t localType,int32_t ascending,int32_t limit,int32_t offset,void**o){return query_messages_ex(get(h),sid,limit,offset,ascending,0,0,std::to_string(localType).c_str(),o);}
WF_EXPORT int32_t wcdb_get_head_image_buffers(int64_t h,const char*idsJson,void**o){
    auto*a=get(h);if(!a||!o)return-1;auto*db=db_in_component(a,"head_image");if(!db)return-1;
    const auto ids=json_strings(idsJson);if(ids.empty()){out(o,"{}");return *o?0:-1;}
    std::string sql="SELECT username,image_buffer FROM head_image WHERE username IN (";
    for(size_t i=0;i<ids.size();++i){if(i)sql+=',';sql+=sql_text(ids[i].c_str());}sql+=')';
    sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
    std::string json="{";bool first=true;
    while(sqlite3_step(st)==SQLITE_ROW){const auto*name=sqlite3_column_text(st,0);if(!name||sqlite3_column_type(st,1)!=SQLITE_BLOB)continue;if(!first)json+=',';first=false;json+=json_key(name)+cell(st,1);}
    sqlite3_finalize(st);out(o,json+'}');return *o?0:-1;
}
WF_EXPORT int32_t wcdb_search_messages(int64_t h,const char*session,const char*keyword,int32_t limit,int32_t offset,int32_t begin,int32_t end,void**o){
    auto*a=get(h);if(!o||!a||!keyword||limit<0||offset<0)return-1;
    std::unordered_map<std::string,std::string> sessionByTable;
    if(session&&*session){const auto hash=session_hash(session);sessionByTable.emplace("msg_"+hash,session);sessionByTable.emplace("msg_"+hash.substr(0,16),session);}
    else{
        const auto table=table_name(a);
        const auto cols=columns(a->db,table);
        const auto username=choose_column(cols,{"username","user_name","userName","talker"});
        if(username.empty())return-2;
        const auto sql="SELECT "+ident(username.c_str())+" FROM "+ident(table.c_str());
        sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(a->db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
        while(sqlite3_step(st)==SQLITE_ROW){const auto sid=column_string(st,0),hash=session_hash(sid.c_str());if(!hash.empty()){sessionByTable.emplace("msg_"+hash,sid);sessionByTable.emplace("msg_"+hash.substr(0,16),sid);}}
        sqlite3_finalize(st);
    }
    struct Stream{sqlite3_stmt*stmt;std::string session;int timeIndex;int idIndex;};
    struct Item{int64_t time;int64_t id;size_t stream;bool operator<(const Item&other)const{return time==other.time?id<other.id:time<other.time;}};
    std::vector<Stream> streams;std::priority_queue<Item> pending;
    auto closeStreams=[&](){for(auto&stream:streams)sqlite3_finalize(stream.stmt);};
    for(size_t dbIndex=0;dbIndex<a->messageDbs.size();++dbIndex){
        if(!is_message_db_path(a->messagePaths[dbIndex]))continue;
        auto*db=a->messageDbs[dbIndex];
        for(const auto&table:message_tables(db)){
            auto match=sessionByTable.find(lower(table));if(match==sessionByTable.end())continue;
            const auto cols=columns(db,table);
            const auto content=find_content_column(cols),time=find_time_column(cols),id=choose_column(cols,{"local_id","localId","MsgLocalID"});
            if(content.empty()||time.empty()||id.empty())continue;
            std::string sql="SELECT * FROM "+ident(table.c_str())+" WHERE instr(lower("+ident(content.c_str())+"),lower(?))>0";
            if(begin>0)sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin);
            if(end>0)sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end);
            sql+=" ORDER BY "+ident(time.c_str())+" DESC,"+ident(id.c_str())+" DESC";
            sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK){closeStreams();return-2;}
            sqlite3_bind_text(st,1,keyword,-1,SQLITE_TRANSIENT);int timeIndex=-1,idIndex=-1;
            for(int col=0;col<sqlite3_column_count(st);++col){if(has_name(sqlite3_column_name(st,col),time.c_str()))timeIndex=col;if(has_name(sqlite3_column_name(st,col),id.c_str()))idIndex=col;}
            const size_t index=streams.size();streams.push_back({st,match->second,timeIndex,idIndex});
            if(sqlite3_step(st)==SQLITE_ROW)pending.push({sqlite3_column_int64(st,timeIndex),sqlite3_column_int64(st,idIndex),index});
        }
    }
    std::string json="[";int seen=0,written=0;const int take=limit>0?limit:50;
    while(!pending.empty()&&written<take){const auto item=pending.top();pending.pop();auto&stream=streams[item.stream];
        if(seen++>=offset){if(written++)json+=',';json+="{\"_session_id\":\""+esc(reinterpret_cast<const unsigned char*>(stream.session.c_str()))+'"';for(int col=0;col<sqlite3_column_count(stream.stmt);++col)json+=','+json_key(reinterpret_cast<const unsigned char*>(sqlite3_column_name(stream.stmt,col)))+cell(stream.stmt,col);json+='}';}
        if(sqlite3_step(stream.stmt)==SQLITE_ROW)pending.push({sqlite3_column_int64(stream.stmt,stream.timeIndex),sqlite3_column_int64(stream.stmt,stream.idIndex),item.stream});
    }
    closeStreams();out(o,json+"]");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_get_sns_timeline(int64_t h,int32_t limit,int32_t offset,const char*usernames,const char*keyword,int32_t begin,int32_t end,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;const auto rows=read_sns_rows(a,begin,end,usernames,keyword,limit,offset,false);std::string j="[";for(size_t i=0;i<rows.size();++i){if(i)j+=',';j+=sns_post_json(rows[i]);}out(outJson,j+"]");return*outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_sns_usernames(int64_t h,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;const auto rows=read_sns_rows(a,0,0,"","",100000,0,true);std::set<std::string> ids;for(const auto&r:rows)if(!r.username.empty())ids.insert(r.username);std::string j="[";bool first=true;for(const auto&id:ids){if(!first)j+=',';first=false;j+='"'+esc(reinterpret_cast<const unsigned char*>(id.c_str()))+'"';}out(outJson,j+"]");return*outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_sns_annual_stats(int64_t h,int32_t begin,int32_t end,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;auto rows=read_sns_rows(a,begin,end,"","",100000,0,true);std::unordered_map<std::string,int64_t> types,likes,comments;for(const auto&r:rows){const auto object=xml_text(r.content,{"TimelineObject"});const auto source=object.empty()?r.content:object;const auto type=xml_text(source,{"type","Type"});++types[type.empty()?"0":type];}auto map=[](const auto&m){std::string x="{";bool f=true;for(const auto&[k,v]:m){if(!f)x+=',';f=false;x+='"'+k+"\":"+std::to_string(v);}return x+'}';};std::string j="{\"totalPosts\":"+std::to_string(rows.size())+",\"typeCounts\":"+map(types)+",\"topLikers\":[],\"topLiked\":[]}";out(outJson,j);return*outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_sns_export_stats(int64_t h,const char*myWxid,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;const auto rows=read_sns_rows(a,0,0,"","",100000,0,true);std::set<std::string> users;int64_t mine=0;for(const auto&r:rows){if(!r.username.empty())users.insert(r.username);if(myWxid&&*myWxid&&_stricmp(r.username.c_str(),myWxid)==0)++mine;}std::string j="{\"total_posts\":"+std::to_string(rows.size())+",\"total_friends\":"+std::to_string(users.size())+",\"my_posts\":"+(myWxid&&*myWxid?std::to_string(mine):"null")+"}";out(outJson,j);return*outJson?0:-1;}
WF_EXPORT int32_t wcdb_get_message_table_columns(int64_t h,const char*path,const char*table,void**o){if(!o||!get(h)||!table)return-1;auto*db=database_for(get(h),"message",path);out(o,json_string_array(columns(db,table)));return 0;}
WF_EXPORT int32_t wcdb_list_tables(int64_t h,const char*kind,const char*path,void**o){if(!o||!get(h))return-1;auto*db=database_for(get(h),kind,path);out(o,json_string_array(message_tables(db)));return 0;}
WF_EXPORT int32_t wcdb_get_table_schema(int64_t h,const char*kind,const char*path,const char*table,void**o){if(!o||!get(h)||!table)return-1;auto*db=database_for(get(h),kind,path);std::string schema=table_schema(db,table);out(o,std::string("{\"success\":true,\"schema\":\"")+esc(reinterpret_cast<const unsigned char*>(schema.c_str()))+"\"}");return 0;}
WF_EXPORT int32_t wcdb_export_table_snapshot(int64_t h,const char*kind,const char*path,const char*table,const char*outputPath,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;auto*db=database_for(a,kind,path);std::string response;const int rc=export_snapshot(db,table,outputPath,response);out(outJson,response);return rc;}
WF_EXPORT int32_t wcdb_import_table_snapshot(int64_t h,const char*kind,const char*path,const char*table,const char*inputPath,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;auto*db=database_for(a,kind,path);std::string response;const int rc=import_snapshot(db,table,inputPath,nullptr,response);out(outJson,response);return rc;}
WF_EXPORT int32_t wcdb_import_table_snapshot_with_schema(int64_t h,const char*kind,const char*path,const char*table,const char*inputPath,const char*createSql,void**outJson){auto*a=get(h);if(!a||!outJson)return-1;auto*db=database_for(a,kind,path);std::string response;const int rc=import_snapshot(db,table,inputPath,createSql,response);out(outJson,response);return rc;}
WF_EXPORT int32_t wcdb_get_message_table_time_range(int64_t h,const char*path,const char*table,void**o){if(!o||!get(h)||!table)return-1;auto*db=database_for(get(h),"message",path);auto cols=columns(db,table);auto time=find_time_column(cols);if(time.empty()){out(o,"{}");return 0;}std::string sql="SELECT min("+ident(time.c_str())+"),max("+ident(time.c_str())+") FROM "+ident(table);sqlite3_stmt*st=nullptr;int64_t first=0,last=0;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_ROW){first=sqlite3_column_int64(st,0);last=sqlite3_column_int64(st,1);}if(st)sqlite3_finalize(st);out(o,"{\"first_timestamp\":"+std::to_string(first)+",\"last_timestamp\":"+std::to_string(last)+"}");return 0;}
WF_EXPORT int32_t wcdb_resolve_image_hardlink(int64_t h,const char*md5,const char*accountDir,void**o){
    auto*a=get(h);if(!a||!md5||!accountDir||!o)return-1;auto*db=db_in_component(a,"hardlink");if(!db)return-1;
    const auto sql="SELECT file_name,dir1,dir2 FROM image_hardlink_info_v4 WHERE lower(md5)=lower("+sql_text(md5)+") OR lower(md5_hash)=lower("+sql_text(md5)+") ORDER BY rowid DESC";
    sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
    sqlite3_stmt*directory=nullptr;
    if(sqlite3_prepare_v2(db,"SELECT username FROM dir2id WHERE rowid=? LIMIT 1",-1,&directory,nullptr)!=SQLITE_OK){sqlite3_finalize(st);return-2;}
    auto resolveDir=[&](int64_t id){sqlite3_reset(directory);sqlite3_clear_bindings(directory);sqlite3_bind_int64(directory,1,id);return sqlite3_step(directory)==SQLITE_ROW?column_string(directory,0):std::string{};};
    std::string json="{}";
    while(sqlite3_step(st)==SQLITE_ROW){
        const auto name=column_string(st,0),dir1=resolveDir(sqlite3_column_int64(st,1)),dir2=resolveDir(sqlite3_column_int64(st,2));
        if(dir1.size()!=32||!std::all_of(dir1.begin(),dir1.end(),[](unsigned char c){return std::isxdigit(c)!=0;})||dir2.size()!=7||dir2[4]!='-'||name.empty()||name.find_first_of("/\\:")!=std::string::npos||name.find("..")!=std::string::npos)continue;
        const auto full=std::filesystem::path(accountDir)/"msg"/"attach"/dir1/dir2/"Img"/name;
        std::error_code ec;if(!std::filesystem::is_regular_file(full,ec))continue;
        const auto path=full.string();
        json="{\"file_name\":\""+esc(reinterpret_cast<const unsigned char*>(name.c_str()))+"\",\"full_path\":\""+esc(reinterpret_cast<const unsigned char*>(path.c_str()))+"\"}";
        break;
    }
    sqlite3_finalize(directory);sqlite3_finalize(st);out(o,json);return *o?0:-1;
}
WF_EXPORT int32_t wcdb_resolve_image_hardlink_batch(int64_t h,const char*requests,void**o){
    auto*a=get(h);if(!a||!requests||!o)return-1;
    sqlite3_stmt*st=nullptr;
    if(sqlite3_prepare_v2(a->db,"SELECT json_extract(value,'$.md5'),json_extract(value,'$.account_dir') FROM json_each(?)",-1,&st,nullptr)!=SQLITE_OK)return-2;
    sqlite3_bind_text(st,1,requests,-1,SQLITE_TRANSIENT);std::string json="[";int index=0,rc;
    while((rc=sqlite3_step(st))==SQLITE_ROW){
        const auto md5=column_string(st,0),dir=column_string(st,1);
        void*raw=nullptr;const int result=wcdb_resolve_image_hardlink(h,md5.c_str(),dir.c_str(),&raw);
        const std::string data=raw?static_cast<const char*>(raw):"{}";if(raw)std::free(raw);
        if(index)json+=',';
        json+="{\"index\":"+std::to_string(index++)+",\"md5\":\""+esc(reinterpret_cast<const unsigned char*>(md5.c_str()))+"\",\"success\":"+(result==0&&data!="{}"?"true":"false")+",\"data\":"+data+'}';
    }
    sqlite3_finalize(st);if(rc!=SQLITE_DONE)return-2;
    out(o,json+"]");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_resolve_video_hardlink_md5(int64_t h,const char*md5,const char*path,void**o){
    auto*a=get(h);if(!a||!md5||!o)return-1;
    auto*db=database_for(a,"hardlink",path);if(!db)return-1;
    const auto sql="SELECT file_name FROM video_hardlink_info_v4 WHERE lower(md5)=lower("+sql_text(md5)+") LIMIT 1";
    sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK)return-2;
    std::string resolved;
    if(sqlite3_step(st)==SQLITE_ROW){auto name=column_string(st,0);auto base=lower(std::filesystem::path(name).stem().string());if(base.size()==32&&std::all_of(base.begin(),base.end(),[](unsigned char c){return std::isxdigit(c)!=0;}))resolved=base;}
    sqlite3_finalize(st);
    out(o,resolved.empty()?"{}":"{\"resolved_md5\":\""+resolved+"\"}");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_resolve_video_hardlink_md5_batch(int64_t h,const char*requests,void**o){
    auto*a=get(h);if(!a||!requests||!o)return-1;
    sqlite3_stmt*st=nullptr;
    if(sqlite3_prepare_v2(a->db,"SELECT json_extract(value,'$.md5'),json_extract(value,'$.db_path') FROM json_each(?)",-1,&st,nullptr)!=SQLITE_OK)return-2;
    sqlite3_bind_text(st,1,requests,-1,SQLITE_TRANSIENT);std::string json="[";int index=0,rc;
    while((rc=sqlite3_step(st))==SQLITE_ROW){
        const auto md5=column_string(st,0),path=column_string(st,1);
        void*raw=nullptr;const int result=wcdb_resolve_video_hardlink_md5(h,md5.c_str(),path.c_str(),&raw);
        const std::string data=raw?static_cast<const char*>(raw):"{}";if(raw)std::free(raw);
        if(index)json+=',';
        json+="{\"index\":"+std::to_string(index++)+",\"md5\":\""+esc(reinterpret_cast<const unsigned char*>(md5.c_str()))+"\",\"success\":"+(result==0&&data!="{}"?"true":"false")+",\"data\":"+data+'}';
    }
    sqlite3_finalize(st);if(rc!=SQLITE_DONE)return-2;
    out(o,json+"]");return *o?0:-1;
}
WF_EXPORT int32_t wcdb_update_message(int64_t h,const char*sessionId,int64_t localId,int32_t createTime,const char*newContent,void**outError){auto*a=get(h);if(!a||!sessionId||!newContent||!outError)return-1;for(size_t i=0;i<a->messageDbs.size();++i){auto*db=a->messageDbs[i];auto table=table_for_session(db,sessionId);if(table.empty())continue;auto cols=columns(db,table);auto id=choose_column(cols,{"local_id","localId","MsgLocalID","msgLocalId"});auto time=find_time_column(cols);auto content=find_content_column(cols);if(id.empty()||content.empty())continue;std::string sql="UPDATE "+ident(table.c_str())+" SET "+ident(content.c_str())+"="+sql_text(newContent)+" WHERE "+ident(id.c_str())+"="+std::to_string(localId);if(createTime>0&&!time.empty())sql+=" AND "+ident(time.c_str())+"="+std::to_string(createTime);char*err=nullptr;const int rc=sqlite3_exec(db,sql.c_str(),nullptr,nullptr,&err);if(rc!=SQLITE_OK){const std::string msg=err?err:sqlite3_errmsg(db);if(err)sqlite3_free(err);return fail(outError,msg.c_str(),rc);}if(sqlite3_changes(db)>0){out(outError,"Success");return 0;}}return fail(outError,"message not found",-2);}
WF_EXPORT int32_t wcdb_delete_message(int64_t h,const char*sessionId,int64_t localId,int32_t createTime,const char*dbPathHint,void**outError){auto*a=get(h);if(!a||!sessionId||!outError)return-1;for(size_t i=0;i<a->messageDbs.size();++i){if(dbPathHint&&*dbPathHint&&_stricmp(a->messagePaths[i].c_str(),dbPathHint)!=0)continue;auto*db=a->messageDbs[i];auto table=table_for_session(db,sessionId);if(table.empty())continue;auto cols=columns(db,table);auto id=choose_column(cols,{"local_id","localId","MsgLocalID","msgLocalId"});auto time=find_time_column(cols);if(id.empty())continue;std::string sql="DELETE FROM "+ident(table.c_str())+" WHERE "+ident(id.c_str())+"="+std::to_string(localId);if(createTime>0&&!time.empty())sql+=" AND "+ident(time.c_str())+"="+std::to_string(createTime);char*err=nullptr;const int rc=sqlite3_exec(db,sql.c_str(),nullptr,nullptr,&err);if(rc!=SQLITE_OK){const std::string msg=err?err:sqlite3_errmsg(db);if(err)sqlite3_free(err);return fail(outError,msg.c_str(),rc);}if(sqlite3_changes(db)>0){out(outError,"Success");return 0;}}return fail(outError,"message not found",-2);}
std::string trigger_ident(const std::string& prefix, const std::string& table) { std::string s=prefix; for(unsigned char c:table) s += std::isalnum(c)?static_cast<char>(c):'_'; return s; }
WF_EXPORT int32_t wcdb_install_message_anti_revoke_trigger(int64_t h,const char*session,void**outError){auto*a=get(h);if(!a||!session||!outError)return-1;if(a->antiRevokeSessions.count(session)){out(outError,"Already installed");return 1;}bool found=false;for(auto*db:a->messageDbs){const auto table=table_for_session(db,session);if(table.empty())continue;found=true;char*err=nullptr;sqlite3_exec(db,"CREATE TABLE IF NOT EXISTS _weflow_anti_revoke_pending (session_id TEXT PRIMARY KEY, updated_at INTEGER)",nullptr,nullptr,&err);if(err)sqlite3_free(err);const auto trig=trigger_ident("anti_revoke_capture_delete_",table);const auto sql="CREATE TRIGGER IF NOT EXISTS "+ident(trig.c_str())+" AFTER DELETE ON "+ident(table.c_str())+" BEGIN INSERT OR REPLACE INTO _weflow_anti_revoke_pending(session_id,updated_at) VALUES ("+sql_text(session)+",strftime('%s','now')); END";if(sqlite3_exec(db,sql.c_str(),nullptr,nullptr,&err)!=SQLITE_OK){const auto msg=err?std::string(err):std::string(sqlite3_errmsg(db));if(err)sqlite3_free(err);return fail(outError,msg.c_str(),-2);}if(err)sqlite3_free(err);}if(!found)return fail(outError,"message table not found",-2);a->antiRevokeSessions.insert(session);out(outError,"Success");return 0;}
WF_EXPORT int32_t wcdb_uninstall_message_anti_revoke_trigger(int64_t h,const char*session,void**outError){auto*a=get(h);if(!a||!session||!outError)return-1;for(auto*db:a->messageDbs){const auto table=table_for_session(db,session);if(table.empty())continue;const auto trig=trigger_ident("anti_revoke_capture_delete_",table);sqlite3_exec(db,("DROP TRIGGER IF EXISTS "+ident(trig.c_str())).c_str(),nullptr,nullptr,nullptr);}a->antiRevokeSessions.erase(session);out(outError,"Success");return 0;}
WF_EXPORT int32_t wcdb_install_sns_block_delete_trigger(int64_t h,void**outError){auto*a=get(h);if(!a||!outError)return-1;auto*db=db_in_component(a,"sns");if(!db)return fail(outError,"sns db not found",-2);const char*sql="CREATE TRIGGER IF NOT EXISTS block_delete_SnsTimeLine BEFORE DELETE ON SnsTimeLine BEGIN SELECT RAISE(IGNORE); END";char*err=nullptr;if(sqlite3_exec(db,sql,nullptr,nullptr,&err)!=SQLITE_OK){const auto msg=err?std::string(err):std::string(sqlite3_errmsg(db));if(err)sqlite3_free(err);return fail(outError,msg.c_str(),-2);}a->snsBlockDelete=true;out(outError,"Success");return 0;}
WF_EXPORT int32_t wcdb_uninstall_sns_block_delete_trigger(int64_t h,void**outError){auto*a=get(h);if(!a||!outError)return-1;if(auto*db=db_in_component(a,"sns"))sqlite3_exec(db,"DROP TRIGGER IF EXISTS block_delete_SnsTimeLine",nullptr,nullptr,nullptr);a->snsBlockDelete=false;out(outError,"Success");return 0;}
WF_EXPORT int32_t wcdb_check_message_anti_revoke_trigger(int64_t h,const char*session,int32_t*outInstalled){auto*a=get(h);if(!a||!session||!outInstalled)return-1;*outInstalled=0;for(auto*db:a->messageDbs){const auto table=table_for_session(db,session);if(table.empty())continue;const auto trig=trigger_ident("anti_revoke_capture_delete_",table);sqlite3_stmt*st=nullptr;const auto sql="SELECT 1 FROM sqlite_master WHERE type='trigger' AND name="+sql_text(trig.c_str());if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_ROW)*outInstalled=1;if(st)sqlite3_finalize(st);if(*outInstalled)break;}return 0;}
WF_EXPORT int32_t wcdb_check_sns_block_delete_trigger(int64_t h,int32_t*outInstalled){auto*a=get(h);if(!a||!outInstalled)return-1;*outInstalled=0;if(auto*db=db_in_component(a,"sns")){sqlite3_stmt*st=nullptr;if(sqlite3_prepare_v2(db,"SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='block_delete_SnsTimeLine'",-1,&st,nullptr)==SQLITE_OK&&sqlite3_step(st)==SQLITE_ROW)*outInstalled=1;if(st)sqlite3_finalize(st);}a->snsBlockDelete=*outInstalled!=0;return 0;}
WF_EXPORT int32_t wcdb_delete_sns_post(int64_t h,const char*postId,void**outError){auto*a=get(h);if(!a||!postId||!*postId||!outError)return-1;auto*db=db_in_component(a,"sns");if(!db)return fail(outError,"sns db not found",-2);const auto id=choose_column(columns(db,"SnsTimeLine"),{"tid","id"});if(id.empty())return fail(outError,"sns table not found",-2);const auto sql="DELETE FROM \"SnsTimeLine\" WHERE "+ident(id.c_str())+"="+sql_text(postId);char*err=nullptr;const int rc=sqlite3_exec(db,sql.c_str(),nullptr,nullptr,&err);if(rc!=SQLITE_OK){const auto msg=err?std::string(err):std::string(sqlite3_errmsg(db));if(err)sqlite3_free(err);return fail(outError,msg.c_str(),rc);}if(sqlite3_changes(db)==0)return fail(outError,"post not found",-2);out(outError,"Success");return 0;}
WF_EXPORT int32_t wcdb_start_monitor_pipe(){
#ifdef _WIN32
    if (monitorRunning.exchange(true)) return 1;
    monitorThread=std::thread([](){
        while(monitorRunning){
            HANDLE pipe=CreateNamedPipeA("\\\\.\\pipe\\weflow_monitor",PIPE_ACCESS_OUTBOUND,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,1,4096,4096,1000,nullptr);
            if(pipe==INVALID_HANDLE_VALUE) break;
            monitorRunning ? ConnectNamedPipe(pipe,nullptr) : false;
            if(monitorRunning){const char msg[]="{\"action\":\"ready\"}\n";DWORD written=0;WriteFile(pipe,msg,sizeof(msg)-1,&written,nullptr);}
            FlushFileBuffers(pipe);DisconnectNamedPipe(pipe);CloseHandle(pipe);
        }
    });
    monitorThread.detach();
    return 0;
#else
    return -1;
#endif
}
WF_EXPORT void wcdb_stop_monitor_pipe(){
#ifdef _WIN32
    monitorRunning=false;
    HANDLE pipe=CreateFileA("\\\\.\\pipe\\weflow_monitor",GENERIC_WRITE,0,nullptr,OPEN_EXISTING,0,nullptr);
    if(pipe!=INVALID_HANDLE_VALUE)CloseHandle(pipe);
#endif
}
WF_EXPORT int32_t wcdb_get_monitor_pipe_name(void**outName){if(!outName)return-1;out(outName,"\\\\.\\pipe\\weflow_monitor");return *outName?0:-1;}
WF_EXPORT void VerifyUser(int64_t,const char*,char*outResult,int32_t maxLen){if(outResult&&maxLen>0){std::strncpy(outResult,"{}",static_cast<size_t>(maxLen)-1);outResult[maxLen-1]=0;}}
WF_EXPORT int32_t wcdb_cloud_init(int32_t){return 0;}
WF_EXPORT int32_t wcdb_cloud_report(const char*){return 0;}
WF_EXPORT void wcdb_cloud_stop(){}
WF_EXPORT int32_t wcdb_get_emoticon_cdn_url(int64_t,const char*,const char*,void**outUrl){if(outUrl)out(outUrl,"");return 0;}
WF_EXPORT int32_t wcdb_get_emoticon_caption(int64_t,const char*,const char*,void**outCaption){if(outCaption)out(outCaption,"");return 0;}
WF_EXPORT int32_t wcdb_get_emoticon_caption_strict(int64_t,const char*,void**outCaption){if(outCaption)out(outCaption,"");return 0;}
WF_EXPORT int32_t wcdb_scan_media_stream(int64_t h,const char*idsJson,int32_t mediaType,int32_t begin,int32_t end,int32_t limit,int32_t offset,void**outJson,int32_t*outHasMore){
    auto*a=get(h);if(!a||!idsJson||!outJson||!outHasMore||limit<=0||offset<0||mediaType<0||mediaType>2)return-1;
    std::unordered_map<std::string,std::string> sessions;
    for(const auto&sid:json_strings(idsJson)){auto hash=session_hash(sid.c_str());if(!hash.empty()){sessions.emplace("msg_"+hash,sid);sessions.emplace("msg_"+hash.substr(0,16),sid);}}
    struct Stream{sqlite3_stmt* stmt;std::string session;int timeIndex;int idIndex;};
    std::vector<Stream> streams;
    struct Item{int64_t time;int64_t id;size_t stream;bool operator<(const Item&other)const{return time==other.time?id<other.id:time<other.time;}};
    std::priority_queue<Item> pending;
    auto closeStreams=[&](){for(auto&stream:streams)sqlite3_finalize(stream.stmt);};
    for(size_t dbIndex=0;dbIndex<a->messageDbs.size();++dbIndex){
        if(!path_has_component(a->messagePaths[dbIndex],"message"))continue;
        auto*db=a->messageDbs[dbIndex];
        for(const auto&table:message_tables(db)){
            auto match=sessions.find(lower(table));if(match==sessions.end())continue;
            const auto cols=columns(db,table);
            const auto type=find_type_column(cols),time=find_time_column(cols),id=choose_column(cols,{"local_id","localId","MsgLocalID"});
            if(type.empty()||time.empty()||id.empty())continue;
            std::string sql="SELECT * FROM "+ident(table.c_str())+" WHERE "+ident(type.c_str());
            sql+=mediaType==1?"=3":mediaType==2?"=43":" IN (3,43)";
            if(begin>0)sql+=" AND "+ident(time.c_str())+">="+std::to_string(begin);
            if(end>0)sql+=" AND "+ident(time.c_str())+"<="+std::to_string(end);
            sql+=" ORDER BY "+ident(time.c_str())+" DESC,"+ident(id.c_str())+" DESC";
            sqlite3_stmt*st=nullptr;
            if(sqlite3_prepare_v2(db,sql.c_str(),-1,&st,nullptr)!=SQLITE_OK){closeStreams();return-2;}
            int timeIndex=-1,idIndex=-1;
            for(int col=0;col<sqlite3_column_count(st);++col){if(has_name(sqlite3_column_name(st,col),time.c_str()))timeIndex=col;if(has_name(sqlite3_column_name(st,col),id.c_str()))idIndex=col;}
            const size_t index=streams.size();streams.push_back({st,match->second,timeIndex,idIndex});
            if(sqlite3_step(st)==SQLITE_ROW)pending.push({sqlite3_column_int64(st,timeIndex),sqlite3_column_int64(st,idIndex),index});
        }
    }
    std::string json="[";int written=0,seen=0;
    while(!pending.empty()&&written<limit){
        const auto item=pending.top();pending.pop();auto&stream=streams[item.stream];
        if(seen++>=offset){
            if(written++)json+=',';
            json+="{\"session_id\":\""+esc(reinterpret_cast<const unsigned char*>(stream.session.c_str()))+'"';
            for(int col=0;col<sqlite3_column_count(stream.stmt);++col)json+=','+json_key(reinterpret_cast<const unsigned char*>(sqlite3_column_name(stream.stmt,col)))+cell(stream.stmt,col);
            json+='}';
        }
        if(sqlite3_step(stream.stmt)==SQLITE_ROW)pending.push({sqlite3_column_int64(stream.stmt,stream.timeIndex),sqlite3_column_int64(stream.stmt,stream.idIndex),item.stream});
    }
    *outHasMore=pending.empty()?0:1;
    closeStreams();out(outJson,json+"]");return *outJson?0:-1;
}
#define OPTIONAL_STUB(name) WF_EXPORT int32_t name(...) { return -1; }
OPTIONAL_STUB(wcdb_add_custom_emoticon)
OPTIONAL_STUB(wcdb_delete_custom_emoticon)
OPTIONAL_STUB(wcdb_update_custom_emoticon)
OPTIONAL_STUB(wcdb_open_message_cursor_with_key)
OPTIONAL_STUB(wcdb_probe_fts_schema)
OPTIONAL_STUB(wcdb_set_monitor)
OPTIONAL_STUB(wcdb_ai_get_conversation_between)
OPTIONAL_STUB(wcdb_ai_get_message_context)
OPTIONAL_STUB(wcdb_ai_get_messages_after)
OPTIONAL_STUB(wcdb_ai_get_messages_before)
OPTIONAL_STUB(wcdb_ai_get_recent_messages)
OPTIONAL_STUB(wcdb_ai_get_search_message_context)
OPTIONAL_STUB(wcdb_ai_get_session_messages)
OPTIONAL_STUB(wcdb_ai_get_session_summaries)
OPTIONAL_STUB(wcdb_ai_query_session_candidates)
OPTIONAL_STUB(wcdb_ai_query_source_refs)
OPTIONAL_STUB(wcdb_ai_query_timeline)
OPTIONAL_STUB(wcdb_ai_query_topic_stats)
OPTIONAL_STUB(wcdb_ai_search_sessions)

