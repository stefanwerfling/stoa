/* A preprocessor-guarded well-formed function and a syntactically broken one;
   the parser is error-tolerant and extraction must not crash. */
#ifdef FEATURE_X
int guarded(int a) {
  if (a > 0) { return 1; }
  return 0;
}
#endif

int oops(int a {
  return a;
}
