/* A deliberately tangled C function (deep nesting + logical operators + many
   parameters) and a clean one that must not be flagged. */
int tangled(int a, int b, int c, int d, int e) {
  if (a > 0) {
    for (int i = 0; i < b; i++) {
      while (c > 0) {
        if (d > 0 && e > 0) {
          if (a > b || c > d) {
            c--;
          }
        }
      }
    }
  }
  return a;
}

int simple(int a) {
  return a + 1;
}
