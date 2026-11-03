#include <exception>

int risky();

// Negative: comment-only catch documents the deliberate ignore.
void documented() {
  try {
    risky();
  } catch (const std::exception& e) {
    // teardown — nothing sensible left to do
  }
}

// Negative: the error is kept for later.
std::exception kept() {
  std::exception last;
  try {
    risky();
  } catch (const std::exception& e) {
    last = e;
  }
  return last;
}

// Positive: default value, no comment, error never read.
int swallowed() {
  try {
    return risky();
  } catch (const std::exception& e) {
    return 0;
  }
}
