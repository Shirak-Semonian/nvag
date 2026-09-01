import { defineConfig } from 'vitest/config'

// Oracle-metadata draait tegen de all_* catalogus-views; onder parallelle
// live-suite-load (pnpm -r test) kan een enkele metadata-call de standaard
// 5s-timeout overschrijden (SAL-36). Hogere timeout alleen voor dit pakket.
export default defineConfig({
  test: {
    testTimeout: 20000
  }
})
