<template>
  <main>
    <!-- flagged: low contrast is judged even under aria-hidden (consistent with HTML) -->
    <p aria-hidden="true" style="color: #999999; background-color: #ffffff">grey on white ~2.85:1</p>
    <!-- flagged: a frame whose aria-labelledby is empty has no accessible name -->
    <iframe src="/x" aria-labelledby=""></iframe>
  </main>
</template>
