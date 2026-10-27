<template>
  <div>
    <img src="/a.png" />
    <img src="/b.png" alt="A described image" />
    <img src="/c.png" :alt="caption" />
    <img :src="icon" v-bind:alt="label" />
    <div role="buton">typo role</div>
    <div :role="dynamicRole">dynamic role, skipped</div>
    <span aria-labeledby="x">unknown aria attr</span>
    <span aria-hidden="yes">invalid aria value</span>
    <button tabindex="5">Jump</button>
    <button aria-hidden="true" tabindex="0">hidden but focusable</button>
    <iframe src="/map"></iframe>
    <iframe src="/v" title="Intro"></iframe>
    <p style="color: #999; background: #fff">low contrast</p>
    <p :style="dynamicStyle">dynamic style, skipped</p>
    <MyButton />
  </div>
</template>
<script setup lang="ts">
const caption = 'x';
</script>
<style scoped>
.x { color: #999; background: #fff; }
</style>
