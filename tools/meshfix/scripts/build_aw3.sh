#!/usr/bin/env bash
# Build the optional CGAL alpha-wrapping helper into meshfix/bin/aw3.
#
# Optional on purpose: meshfix installs and runs with pip alone, and the
# alphawrap backend simply reports itself unavailable when this binary is
# missing (the chain then falls through to `voxel`). Nothing here is required
# to diagnose or repair a mesh — it buys a far better *shape* when it is
# available, because a wrap follows the surface instead of quantising it.
#
# Needs: CGAL 5.5+, Boost, Eigen, CMake 3.12+, a C++17 compiler.
#   Debian/Ubuntu  sudo apt-get install libcgal-dev libboost-dev libeigen3-dev cmake
#   macOS          brew install cgal boost eigen cmake
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
build="${root}/cpp/build"
target="${root}/meshfix/bin/aw3"

if ! command -v cmake >/dev/null 2>&1; then
  echo "build_aw3: cmake not found; see the header of this script" >&2
  exit 1
fi

cmake -S "${root}/cpp" -B "${build}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${build}" --parallel

mkdir -p "$(dirname "${target}")"
cp "${build}/aw3" "${target}"
echo "build_aw3: installed ${target}"
"${target}" 2>&1 | head -1 || true
