// Fixtures for R-CPP-UNRELEASED-ALLOCATION and R-CPP-NEW-DELETE-MISMATCH.
// Each function name below is referenced directly by test/Cpp.test.ts.

void leakedNew() {
  int* x = new int(5);
}

void leakedMalloc() {
  char* buf = (char*)malloc(100);
}

void matchedNew() {
  int* p = new int;
  delete p;
}

void matchedArray() {
  int* arr = new int[10];
  delete[] arr;
}

void mismatchedArray() {
  int* arr = new int[10];
  delete arr;
}

void mismatchedScalar() {
  int* p = new int;
  delete[] p;
}

void matchedMalloc() {
  char* buf = (char*)malloc(100);
  free(buf);
}

void escapesViaCall() {
  int* p = new int(5);
  process(p);
}

int* escapesViaReturn() {
  int* y = new int(5);
  return y;
}

void escapesViaReassign() {
  int* a = new int(5);
  int* b = a;
}

void usedThenLeaked() {
  int* p = new int(5);
  *p = 10;
}

void reallocPattern() {
  char* buf = (char*)malloc(10);
  buf = (char*)realloc(buf, 20);
  free(buf);
}

void noInitializerNotTracked() {
  int* p;
  p = new int(5);
}

void callocLeak() {
  int* arr = (int*)calloc(10, sizeof(int));
}

void lambdaLeakNotAttributed() {
  auto fn = []() {
    int* inner = new int(1);
  };
  fn();
}

struct Pool {};

Pool& intentionalSingletonLeak() {
  static Pool* p = new Pool();
  return *p;
}

struct Buf { void* raw; int size; };

Buf escapesViaBracedReturn() {
  auto* raw = new char[10];
  return Buf{raw, 10};
}

void placementNewIsNotAnAllocation(void* storage) {
  Pool* p = new (storage) Pool();
}

void releasedThroughACast() {
  void* buf = malloc(100);
  free((void*)buf);
}

