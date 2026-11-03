// Regression fixture (SwipeMeister false positives): a catch that documents why
// it ignores the error, or that keeps the error for later, is not swallowed.
Future<void> logout() async {
  try {
    await postRaw('/login/logout');
  } catch (_) {
    // Offline or backend down — proceed with the local wipe anyway.
  }
}

Future<Object?> retry() async {
  Object? lastError;
  for (int attempt = 0; attempt < 3; attempt++) {
    try {
      return await loginToken();
    } catch (e) {
      lastError = e;
    }
  }
  return lastError;
}

Object? swallowed() {
  try {
    return parse();
  } catch (_) {
    return null;
  }
}

void swallowedEmpty() {
  try {
    parse();
  } catch (e) {}
}
