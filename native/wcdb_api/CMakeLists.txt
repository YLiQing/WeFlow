cmake_minimum_required(VERSION 3.20)
project(weflow_wcdb_api LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(WCDB_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../tmp/wcdb-2.1.16")
set(WCDB_BUILD "${CMAKE_CURRENT_LIST_DIR}/../../tmp/wcdb-build-20261006")
set(OPENSSL_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../tmp/wcdb-2.1.16/tools/prebuild/openssl")

add_library(wcdb_api SHARED wcdb_api.cpp)
target_include_directories(wcdb_api PRIVATE
  "${WCDB_ROOT}/src/common"
  "${WCDB_ROOT}/src/cpp"
  "${WCDB_ROOT}/src/bridge"
  "${WCDB_ROOT}/sqlcipher"
  "${WCDB_ROOT}/sqlcipher/src"
)
target_link_libraries(wcdb_api PRIVATE
  "${WCDB_BUILD}/Release/WCDB.lib"
  "${WCDB_BUILD}/Release/sqlcipher.lib"
  "${OPENSSL_ROOT}/windows/win64/libcrypto.lib"
  Crypt32 Ws2_32
)
target_include_directories(wcdb_api PRIVATE "${OPENSSL_ROOT}/include")
target_compile_definitions(wcdb_api PRIVATE _WIN64 WIN64 SQLITE_HAS_CODEC=1)
target_compile_options(wcdb_api PRIVATE /EHsc /utf-8)
set_target_properties(wcdb_api PROPERTIES OUTPUT_NAME "wcdb_api")

add_executable(wcdb_api_test wcdb_api_test.cpp)
target_include_directories(wcdb_api_test PRIVATE "${WCDB_ROOT}/sqlcipher" "${WCDB_ROOT}/sqlcipher/src")
target_link_libraries(wcdb_api_test PRIVATE wcdb_api "${WCDB_BUILD}/Release/sqlcipher.lib" "${OPENSSL_ROOT}/windows/win64/libcrypto.lib" Crypt32 Ws2_32)
target_include_directories(wcdb_api_test PRIVATE "${OPENSSL_ROOT}/include")
target_compile_definitions(wcdb_api_test PRIVATE _WIN64 WIN64 SQLITE_HAS_CODEC=1)
target_compile_options(wcdb_api_test PRIVATE /EHsc /utf-8)
