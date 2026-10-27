// An empty catch swallows the error (flagged); a rethrowing one and one that
// logs are both fine.
void handlers() {
  try {
    risky();
  } catch (e) {}

  try {
    risky();
  } catch (e) {
    rethrow;
  }

  try {
    risky();
  } catch (e) {
    log(e);
  }
}
