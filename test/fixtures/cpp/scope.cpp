// Fixtures for scope-aware variable identity (Phase 4 of the Analysis
// Integrity & Memory-Bounded Pipeline spec). Each function name below is
// referenced directly by test/Cpp.test.ts.

void nestedShadowOuterLeaked() {
  int* p = new int(1);
  {
    int* p = new int(2);
    delete p;
  }
}

void nestedShadowBothReleased() {
  int* p = new int(1);
  {
    int* p = new int(2);
    delete p;
  }
  delete p;
}

void nullptrAfterAllocationStillLeaked() {
  int* p = new int(5);
  p = nullptr;
}

void nullptrAfterFreeIsFine() {
  int* p = new int(5);
  delete p;
  p = nullptr;
}

void overwriteWithNewAllocationLeaksOriginal() {
  int* p = new int(1);
  p = new int(2);
}

void shadowByNonPointerLocal() {
  int* p = new int(1);
  {
    int p = 5;
    p = p + 1;
  }
}

void siblingBlocksSameNameBothLeaked() {
  {
    int* p = new int(1);
  }
  {
    int* p = new int(2);
  }
}

void preprocBranchAllocationReleased() {
#ifndef STOA_TEST_ROCM
  int* p = (int*)malloc(sizeof(int));
#else
  int* p = (int*)malloc(sizeof(int) * 2);
#endif
  free(p);
}
