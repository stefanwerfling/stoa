#include <cstdlib>

// The lambda is deeply nested and calls rand(); the enclosing function itself is
// trivial and deterministic. Neither the complexity nor the nondeterminism of
// the lambda may be attributed to outer().
int outer() {
  auto f = [](int a, int b) {
    if (a > 0) {
      for (int i = 0; i < b; i++) {
        if (a > b && b > 0) {
          return rand();
        }
      }
    }
    return 0;
  };
  return 0;
}

// A direct call in the function body — must be flagged.
int direct() {
  return rand();
}
