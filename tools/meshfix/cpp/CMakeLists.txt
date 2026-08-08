cmake_minimum_required(VERSION 3.12)
project(aw3 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# CGAL is header-only here, but its config still supplies the GMP/MPFR links and
# the rounding-mode flags that its exact predicates depend on. Do not substitute
# a bare `g++ -lgmp -lmpfr`: it happens to work on Linux and silently drops
# those flags elsewhere.
find_package(CGAL REQUIRED)

add_executable(aw3 aw3.cpp)
target_link_libraries(aw3 PRIVATE CGAL::CGAL)
target_compile_definitions(aw3 PRIVATE CGAL_NDEBUG)
