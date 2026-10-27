<template>
  <main>
    <img src="/ok.png" alt="A described image" />
    <img src="/deco.png" alt="" />
    <button :aria-label="closeLabel">×</button>
    <div role="navigation" aria-hidden="true">off-tree</div>
    <a href="/go" tabindex="0">Go</a>
    <iframe src="/m" title="Location map"></iframe>
    <p style="color: #000000; background: #ffffff">readable</p>
  </main>
</template>
<script setup lang="ts">
const closeLabel = 'Close';
</script>
