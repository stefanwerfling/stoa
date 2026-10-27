// An empty catch swallows the error (flagged); a rethrowing one and one that
// logs are both fine.
void handlers() {
  try {
    risky();
  } catch (const std::exception& e) {
  }

  try {
    risky();
  } catch (...) {
    throw;
  }

  try {
    risky();
  } catch (const std::exception& e) {
    log(e);
  }
}
