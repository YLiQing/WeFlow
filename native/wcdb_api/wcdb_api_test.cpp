#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <string>
#include <windows.h>
#include <openssl/evp.h>
#include "sqlite3.h"

#undef assert
#define assert(condition) do { if (!(condition)) { std::cerr << "check failed at line " << __LINE__ << ": " #condition << '\n'; std::abort(); } } while (false)

extern "C" int32_t wcdb_init();
extern "C" int32_t wcdb_shutdown();
extern "C" int32_t wcdb_open_account(const char*, const char*, int64_t*);
extern "C" int32_t wcdb_set_my_wxid(int64_t, const char*);
extern "C" int32_t wcdb_get_messages(int64_t, const char*, int32_t, int32_t, void**);
extern "C" int32_t wcdb_close_account(int64_t);
extern "C" int32_t wcdb_search_messages(int64_t, const char*, const char*, int32_t, int32_t, int32_t, int32_t, void**);
extern "C" int32_t wcdb_get_group_nicknames(int64_t, const char*, void**);
extern "C" int32_t wcdb_get_group_stats(int64_t, const char*, int32_t, int32_t, void**);
extern "C" int32_t wcdb_get_aggregate_stats(int64_t, const char*, int32_t, int32_t, void**);
extern "C" int32_t wcdb_get_annual_report_stats(int64_t, const char*, int32_t, int32_t, void**);
extern "C" int32_t wcdb_export_table_snapshot(int64_t, const char*, const char*, const char*, const char*, void**);
extern "C" int32_t wcdb_import_table_snapshot(int64_t, const char*, const char*, const char*, const char*, void**);
extern "C" int32_t wcdb_get_sns_timeline(int64_t, int32_t, int32_t, const char*, const char*, int32_t, int32_t, void**);
extern "C" int32_t wcdb_get_sns_usernames(int64_t, void**);
extern "C" int32_t wcdb_get_sns_annual_stats(int64_t, int32_t, int32_t, void**);
extern "C" int32_t wcdb_get_sns_export_stats(int64_t, const char*, void**);
extern "C" int32_t wcdb_update_message(int64_t, const char*, int64_t, int32_t, const char*, void**);
extern "C" int32_t wcdb_delete_message(int64_t, const char*, int64_t, int32_t, const char*, void**);
extern "C" int32_t wcdb_get_my_footprint_stats(int64_t, const char*, void**);
extern "C" int32_t wcdb_install_message_anti_revoke_trigger(int64_t, const char*, void**);
extern "C" int32_t wcdb_check_message_anti_revoke_trigger(int64_t, const char*, int32_t*);
extern "C" int32_t wcdb_uninstall_message_anti_revoke_trigger(int64_t, const char*, void**);
extern "C" int32_t wcdb_install_sns_block_delete_trigger(int64_t, void**);
extern "C" int32_t wcdb_check_sns_block_delete_trigger(int64_t, int32_t*);
extern "C" int32_t wcdb_uninstall_sns_block_delete_trigger(int64_t, void**);
extern "C" int32_t wcdb_delete_sns_post(int64_t, const char*, void**);
extern "C" int32_t wcdb_get_monitor_pipe_name(void**);
extern "C" void wcdb_free_string(void*);

static constexpr char key[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

void exec(sqlite3* db, const std::string& sql) {
    char* error = nullptr;
    const int rc = sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &error);
    if (rc != SQLITE_OK) {
        std::cerr << "fixture SQL failed: " << (error ? error : "unknown") << '\n';
        sqlite3_free(error);
        std::abort();
    }
}

sqlite3* create_db(const std::filesystem::path& path) {
    std::filesystem::create_directories(path.parent_path());
    sqlite3* db = nullptr;
    assert(sqlite3_open_v2(path.string().c_str(), &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr) == SQLITE_OK);
    unsigned char bytes[32]{};
    for (size_t i = 0; i < 32; ++i) bytes[i] = static_cast<unsigned char>(std::stoul(std::string(key + i * 2, 2), nullptr, 16));
    assert(sqlite3_key(db, bytes, 32) == SQLITE_OK);
    return db;
}

std::string hash(const char* text) {
    unsigned char digest[16]{};
    unsigned int size = 0;
    assert(EVP_Digest(text, std::strlen(text), digest, &size, EVP_md5(), nullptr) == 1);
    std::string result;
    static constexpr char digits[] = "0123456789abcdef";
    for (unsigned char byte : digest) { result += digits[byte >> 4]; result += digits[byte & 15]; }
    return result;
}

std::string query(int32_t (*call)(int64_t, const char*, const char*, int32_t, int32_t, int32_t, int32_t, void**), int64_t handle, const char* session, const char* keyword, int offset) {
    void* output = nullptr;
    assert(call(handle, session, keyword, 1, offset, 0, 0, &output) == 0 && output);
    std::string result(static_cast<const char*>(output));
    wcdb_free_string(output);
    return result;
}

int main() {
    const auto root = std::filesystem::temp_directory_path() / ("weflow_wcdb_api_test_" + std::to_string(GetCurrentProcessId()));
    const auto session = root / "session" / "session.db";
    const auto messages0 = root / "message" / "message_0.db";
    const auto messages1 = root / "message" / "message_1.db";
    const auto contact = root / "contact" / "contact.db";
    for (const auto& path : { session, messages0, messages1, contact }) std::filesystem::remove(path);

    auto* db = create_db(session);
    exec(db, "CREATE TABLE SessionTable(username TEXT); INSERT INTO SessionTable VALUES('alice_id'),('bob_id'),('room@chatroom');");
    sqlite3_close(db);
    db = create_db(messages0);
    exec(db, "CREATE TABLE \"Msg_" + hash("alice_id") + "\"(local_id INTEGER, create_time INTEGER, message_content TEXT, computed_is_send INTEGER);"
             "INSERT INTO \"Msg_" + hash("alice_id") + "\" VALUES(1,300,'needle alpha',1),(2,100,'needle old',0);");
    exec(db, "CREATE TABLE \"Msg_" + hash("room@chatroom") + "\"(local_id INTEGER, create_time INTEGER, message_content TEXT, is_send INTEGER, computed_is_send INTEGER, real_sender_id TEXT);"
             "INSERT INTO \"Msg_" + hash("room@chatroom") + "\" VALUES(8,403,'mine text id',1,0,'1');");
    exec(db, "CREATE TABLE imported(local_id INTEGER, create_time INTEGER, message_content TEXT, computed_is_send INTEGER);");
    sqlite3_close(db);
    db = create_db(messages1);
    exec(db, "CREATE TABLE \"Msg_" + hash("bob_id") + "\"(local_id INTEGER, create_time INTEGER, message_content TEXT);"
             "INSERT INTO \"Msg_" + hash("bob_id") + "\" VALUES(3,200,'needle beta'),(4,50,'other');");
    exec(db, "CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id(rowid,user_name) VALUES(1,'alice_id'),(2,'bob_id');"
             "CREATE TABLE \"Msg_" + hash("room@chatroom") + "\"(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER, real_sender_id INTEGER);"
             "INSERT INTO \"Msg_" + hash("room@chatroom") + "\" VALUES(5,400,'hello',1,1),(6,401,'photo',3,2),(7,402,'again',1,1);");
    sqlite3_close(db);
    db = create_db(contact);
    exec(db, "CREATE TABLE chat_room(username TEXT, ext_buffer BLOB);");
    const unsigned char buffer[] = { 0x0a,8,'a','l','i','c','e','_','i','d',0x12,5,'A','l','i','c','e',0x0a,6,'b','o','b','_','i','d',0x12,3,'B','o','b' };
    sqlite3_stmt* insert = nullptr;
    assert(sqlite3_prepare_v2(db, "INSERT INTO chat_room VALUES('room@chatroom',?)", -1, &insert, nullptr) == SQLITE_OK);
    assert(sqlite3_bind_blob(insert, 1, buffer, sizeof(buffer), SQLITE_TRANSIENT) == SQLITE_OK);
    assert(sqlite3_step(insert) == SQLITE_DONE);
    sqlite3_finalize(insert);
    sqlite3_close(db);
    db = create_db(root / "sns" / "sns.db");
    exec(db, "CREATE TABLE SnsTimeLine(tid TEXT, content TEXT, user_name TEXT, createTime INTEGER);"
             "INSERT INTO SnsTimeLine VALUES('tid-1','<TimelineObject><contentDesc>hello sns</contentDesc><type>1</type><userName>alice_id</userName></TimelineObject>','alice_id',1000);"
             "INSERT INTO SnsTimeLine VALUES('tid-2','<TimelineObject><contentDesc>second</contentDesc><type>2</type><userName>bob_id</userName></TimelineObject>','bob_id',2000);");
    sqlite3_close(db);

    assert(wcdb_init() == 0);
    int64_t handle = 0;
    assert(wcdb_open_account(session.string().c_str(), key, &handle) == 0 && handle > 0);
    assert(wcdb_set_my_wxid(handle, "alice_id") == 0);
    void* directionOutput = nullptr;
    assert(wcdb_get_messages(handle, "room@chatroom", 10, 0, &directionOutput) == 0 && directionOutput);
    const std::string directions(static_cast<const char*>(directionOutput)); wcdb_free_string(directionOutput);
    assert(directions.find("\"message_content\":\"mine text id\"") != std::string::npos);
    assert(directions.find("\"_weflow_is_send\":1") != std::string::npos);
    assert(directions.find("\"_weflow_sender_username\":\"alice_id\"") != std::string::npos);
    const auto first = query(wcdb_search_messages, handle, "", "needle", 0);
    const auto second = query(wcdb_search_messages, handle, "", "needle", 1);
    const auto third = query(wcdb_search_messages, handle, "", "needle", 2);
    assert(first.find("\"_session_id\":\"alice_id\"") != std::string::npos && first.find("\"create_time\":300") != std::string::npos);
    assert(second.find("\"_session_id\":\"bob_id\"") != std::string::npos && second.find("\"create_time\":200") != std::string::npos);
    assert(third.find("\"_session_id\":\"alice_id\"") != std::string::npos && third.find("\"create_time\":100") != std::string::npos);
    void* output = nullptr;
    assert(wcdb_get_group_nicknames(handle, "room@chatroom", &output) == 0 && output);
    const std::string nicknames(static_cast<const char*>(output));
    wcdb_free_string(output);
    assert(nicknames.find("\"alice_id\":\"Alice\"") != std::string::npos);
    assert(nicknames.find("\"bob_id\":\"Bob\"") != std::string::npos);
    output = nullptr;
    const char* ids = "[\"alice_id\",\"bob_id\",\"room@chatroom\"]";
    output = nullptr;
    assert(wcdb_get_aggregate_stats(handle, ids, 0, 0, &output) == 0 && output);
    const std::string aggregate(static_cast<const char*>(output));
    wcdb_free_string(output);
    assert(aggregate.find("\"total\":8") != std::string::npos);
    assert(aggregate.find("\"alice_id\":{\"total\":2,\"totalMessages\":2,\"sent\":1,\"received\":1") != std::string::npos);
    assert(aggregate.find("\"monthly\":{") != std::string::npos);
    assert(aggregate.find("\"1970-01-01\":8") != std::string::npos);
    assert(aggregate.find("\"typeCounts\":{") != std::string::npos);
    assert(aggregate.find("\"firstTime\":50") != std::string::npos);
    assert(aggregate.find("\"lastTime\":403") != std::string::npos);
    output = nullptr;
    assert(wcdb_get_annual_report_stats(handle, ids, 0, 0, &output) == 0 && output);
    const std::string annual(static_cast<const char*>(output));
    wcdb_free_string(output);
    assert(annual == aggregate);
    const auto snapshot = root / "message.snapshot";
    output = nullptr;
    const auto exportRc = wcdb_export_table_snapshot(handle, "message", messages0.string().c_str(), ("Msg_" + hash("alice_id")).c_str(), snapshot.string().c_str(), &output);
    assert(exportRc == 0 && output);
    const std::string exported(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(exported.find("\"success\":true") != std::string::npos && exported.find("\"rows\":2") != std::string::npos);
    { std::ifstream snapshotFile(snapshot, std::ios::binary); std::string header; std::getline(snapshotFile, header); assert(header == "WEFLOW_SNAPSHOT_V1"); }
    output = nullptr;
    const auto importRc = wcdb_import_table_snapshot(handle, "message", messages0.string().c_str(), "imported", snapshot.string().c_str(), &output);
    assert(importRc == 0 && output);
    const std::string imported(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(imported.find("\"inserted\":2") != std::string::npos);
    output = nullptr;
    assert(wcdb_get_sns_timeline(handle, 20, 0, "", "hello", 0, 0, &output) == 0 && output);
    const std::string timeline(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(timeline.find("tid-1") != std::string::npos && timeline.find("hello sns") != std::string::npos);
    output = nullptr;
    assert(wcdb_get_sns_usernames(handle, &output) == 0 && output);
    const std::string snsUsers(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(snsUsers.find("alice_id") != std::string::npos && snsUsers.find("bob_id") != std::string::npos);
    output = nullptr;
    assert(wcdb_get_sns_annual_stats(handle, 0, 0, &output) == 0 && output);
    const std::string snsAnnual(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(snsAnnual.find("\"totalPosts\":2") != std::string::npos);
    output = nullptr;
    assert(wcdb_get_sns_export_stats(handle, "alice_id", &output) == 0 && output);
    const std::string snsExport(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(snsExport.find("\"total_posts\":2") != std::string::npos && snsExport.find("\"my_posts\":1") != std::string::npos);
    output = nullptr;
    assert(wcdb_get_my_footprint_stats(handle, "{\"begin\":0,\"end\":0,\"my_wxid\":\"me\",\"private_session_ids\":[\"alice_id\"],\"group_session_ids\":[]}", &output) == 0 && output);
    const std::string footprint(static_cast<const char*>(output)); wcdb_free_string(output);
    assert(footprint.find("\"private_inbound_people\":1") != std::string::npos);
    assert(footprint.find("\"outgoing_count\":1") != std::string::npos);
    int32_t installed = 0;
    output = nullptr; assert(wcdb_install_message_anti_revoke_trigger(handle, "alice_id", &output) == 0 && output); wcdb_free_string(output);
    assert(wcdb_check_message_anti_revoke_trigger(handle, "alice_id", &installed) == 0 && installed == 1);
    output = nullptr; assert(wcdb_uninstall_message_anti_revoke_trigger(handle, "alice_id", &output) == 0 && output); wcdb_free_string(output);
    output = nullptr; assert(wcdb_install_sns_block_delete_trigger(handle, &output) == 0 && output); wcdb_free_string(output);
    assert(wcdb_check_sns_block_delete_trigger(handle, &installed) == 0 && installed == 1);
    output = nullptr; assert(wcdb_uninstall_sns_block_delete_trigger(handle, &output) == 0 && output); wcdb_free_string(output);
    output = nullptr; assert(wcdb_delete_sns_post(handle, "tid-1", &output) == 0 && output); wcdb_free_string(output);
    output = nullptr; assert(wcdb_get_monitor_pipe_name(&output) == 0 && output); wcdb_free_string(output);
    output = nullptr;
    assert(wcdb_update_message(handle, "alice_id", 1, 300, "updated", &output) == 0 && output); wcdb_free_string(output);
    output = nullptr;
    assert(wcdb_delete_message(handle, "alice_id", 2, 100, "", &output) == 0 && output); wcdb_free_string(output);
    assert(wcdb_close_account(handle) == 0);
    std::filesystem::remove_all(root);
    std::cout << "wcdb_api synthetic search, nickname, group, and annual checks passed\\n";
    return 0;
}
