# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e.spec.ts >> Provisioning Platform E2E - Production Flow >> should complete the entire lifecycle
- Location: tests/e2e.spec.ts:6:7

# Error details

```
Error: page.click: Target page, context or browser has been closed
Call log:
  - waiting for locator('button:has-text("Provision Cluster")')

```

```
Error: browserContext.close: Target page, context or browser has been closed
```