// CGAL 3D Alpha Wrapping helper for meshfix (SPEC 7.1).
//
// A separate binary rather than a Python binding, because the only maintained
// binding (CGAL's own SWIG bindings) does not expose alpha_wrap_3, and building
// one would make an *optional* backend a compile-time dependency of the whole
// tool. A process boundary keeps meshfix installable with pip alone; when the
// binary is absent the backend reports itself unavailable and the chain moves
// on (change C14).
//
// The input is read as a polygon **soup**, not a mesh. That is the entire point
// of this backend: it is reached for inputs whose connectivity is broken —
// non-manifold edges, flipped windings, disconnected components — and requiring
// a valid mesh to read them would refuse exactly the files it exists to fix.
//
//   aw3 INPUT OUTPUT --alpha A --offset O
//
// Exit codes: 0 wrote a mesh, 1 could not read the input, 2 bad arguments.
// The wrap's own quality is not judged here — meshfix validates the result.

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/alpha_wrap_3.h>
#include <CGAL/IO/polygon_soup_io.h>
#include <CGAL/Polygon_mesh_processing/IO/polygon_mesh_io.h>
#include <CGAL/Polygon_mesh_processing/repair_polygon_soup.h>

#include <array>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using Kernel = CGAL::Exact_predicates_inexact_constructions_kernel;
using Point_3 = Kernel::Point_3;
using Mesh = CGAL::Surface_mesh<Point_3>;

namespace {

int usage(const char* program) {
  std::cerr << "usage: " << program
            << " INPUT OUTPUT --alpha A --offset O\n"
               "  INPUT   mesh in any format CGAL reads (stl, off, obj, ply)\n"
               "  OUTPUT  written as .stl\n"
               "  --alpha   size of the smallest feature the wrap can enter\n"
               "  --offset  distance the wrap keeps from the input surface\n";
  return 2;
}

bool parse_double(const char* text, double& out) {
  char* end = nullptr;
  const double value = std::strtod(text, &end);
  if (end == text || *end != '\0' || !(value > 0.0)) return false;
  out = value;
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) return usage(argv[0]);

  const std::string input_path = argv[1];
  const std::string output_path = argv[2];
  double alpha = 0.0;
  double offset = 0.0;

  for (int i = 3; i + 1 < argc; i += 2) {
    const std::string flag = argv[i];
    if (flag == "--alpha") {
      if (!parse_double(argv[i + 1], alpha)) return usage(argv[0]);
    } else if (flag == "--offset") {
      if (!parse_double(argv[i + 1], offset)) return usage(argv[0]);
    } else {
      return usage(argv[0]);
    }
  }
  if (alpha <= 0.0 || offset <= 0.0) return usage(argv[0]);

  std::vector<Point_3> points;
  std::vector<std::array<std::size_t, 3>> faces;
  if (!CGAL::IO::read_polygon_soup(input_path, points, faces) || faces.empty()) {
    std::cerr << "aw3: cannot read a polygon soup from " << input_path << "\n";
    return 1;
  }

  // Merge coincident corners and drop degenerate faces. Without this an STL —
  // which stores every triangle's corners separately — arrives as a soup where
  // no two faces share a point, and the wrap has to rediscover the surface from
  // scratch.
  CGAL::Polygon_mesh_processing::repair_polygon_soup(points, faces);

  std::cerr << "aw3: " << points.size() << " points, " << faces.size()
            << " faces, alpha=" << alpha << " offset=" << offset << "\n";

  Mesh wrap;
  CGAL::alpha_wrap_3(points, faces, alpha, offset, wrap);

  if (wrap.is_empty()) {
    std::cerr << "aw3: the wrap is empty; alpha is probably larger than the model\n";
    return 1;
  }
  if (!CGAL::IO::write_polygon_mesh(output_path, wrap, CGAL::parameters::stream_precision(17))) {
    std::cerr << "aw3: cannot write " << output_path << "\n";
    return 1;
  }

  std::cerr << "aw3: wrote " << wrap.number_of_vertices() << " vertices, "
            << wrap.number_of_faces() << " faces\n";
  return 0;
}
