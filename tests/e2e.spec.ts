import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Provisioning Platform E2E Suite', () => {
  const CLUSTER_NAME = `e2e-fleet-${Math.floor(Math.random() * 1000)}`;

  test.beforeAll(async () => {
    console.log(`🚀 Starting E2E test suite for cluster: ${CLUSTER_NAME}`);
    try {
      console.log('Stopping k3d-Lunorica-local-server-0 to avoid hostnetwork conflicts...');
      execSync('docker stop k3d-Lunorica-local-server-0', { stdio: 'inherit' });
    } catch (e: any) {
      console.log(`Note: Local cluster was not running or could not be stopped: ${e.message}`);
    }

    // Reset nginx.conf to standard clean configuration to avoid cascading reload failures
    try {
      console.log('Resetting nginx.conf to clean default state...');
      const cleanConfig = `user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;
    client_max_body_size 10G;

    include /etc/nginx/conf.d/*.conf;
}
`;
      const nginxConfPath = path.join(__dirname, '../apps/backend/data/nginx/nginx.conf');
      fs.writeFileSync(nginxConfPath, cleanConfig, 'utf-8');
      console.log('Reloading provisioner-nginx...');
      execSync('docker exec provisioner-nginx nginx -s reload', { stdio: 'inherit' });
    } catch (e: any) {
      console.error(`Failed to reset nginx.conf: ${e.message}`);
    }
  });

  test.afterAll(async () => {
    console.log(`🧹 E2E afterAll: Cleaning up cluster ${CLUSTER_NAME}...`);
    try {
      execSync(`./bin/k3d cluster delete ${CLUSTER_NAME}`, { stdio: 'inherit' });
    } catch (e: any) {
      console.error(`Failed to delete cluster in afterAll: ${e.message}`);
    }
    try {
      console.log('Restarting k3d-Lunorica-local-server-0...');
      execSync('docker start k3d-Lunorica-local-server-0', { stdio: 'inherit' });
    } catch (e: any) {
      console.error(`Failed to restart local cluster: ${e.message}`);
    }
  });

  // HELPER: Deploy an application using the wizard
  async function deployApplication(page: any, name: string, appType: string, strategy: 'helm' | 'native', isDbApp: boolean, clusterName?: string) {
    await page.click('button:has-text("Applications")');
    await page.click('button:has-text("Deploy App")');

    // Step 1: Base Configuration
    const targetCluster = clusterName || CLUSTER_NAME;
    const option = page.locator(`#wizard-target-cluster option:has-text("${targetCluster}")`);
    const optionValue = await option.getAttribute('value');
    await page.selectOption('#wizard-target-cluster', optionValue || '');
    await page.selectOption('#wizard-app-type', appType);
    await page.fill('#wizard-instance-name', name);
    await expect(page.locator('button:has-text("Next")')).toBeEnabled();
    await page.click('button:has-text("Next")');

    // Step 2: Deployment Strategy
    if (strategy === 'helm') {
      await page.click('button:has-text("Helm Chart")');
    } else {
      await page.click('button:has-text("Native K8s")');
    }
    await expect(page.locator('button:has-text("Next")')).toBeEnabled();
    await page.click('button:has-text("Next")');

    // Step 3: Windscribe VPN Routing (Only for native strategy)
    if (strategy === 'native') {
      await expect(page.locator('h4:has-text("Windscribe VPN Routing")')).toBeVisible();
      await expect(page.locator('button:has-text("Next")')).toBeEnabled();
      await page.click('button:has-text("Next")');
    }

    // Step 4: Component Version (Main App)
    await page.waitForSelector('button:has-text("Next")');
    await expect(page.locator('button:has-text("Next")')).toBeEnabled();
    await page.click('button:has-text("Next")');

    // Step 5: Component Version (Database)
    if (isDbApp) {
      await page.waitForSelector('button:has-text("Next")');
      await expect(page.locator('button:has-text("Next")')).toBeEnabled();
      await page.click('button:has-text("Next")');
    }

    // Step 6: Confirm and Initiate
    await expect(page.locator('button:has-text("Initiate Deployment")')).toBeEnabled();
    await page.click('button:has-text("Initiate Deployment")');

    // Monitor trace and close logs modal
    await expect(page.locator('h3:has-text("Dashboard")')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(5000);
    await page.click('button:has(.lucide-x)');
  }

  // HELPER: Verify the 5 dashboard logging tabs
  async function verifyLoggingTabs(page: any, name: string, hasHelm: boolean) {
    const row = page.locator(`tr:has-text("${name}")`);
    await row.locator('button:has-text("Manage")').click();

    // Verify modal title
    await expect(page.locator(`h3:has-text("${name} Dashboard")`)).toBeVisible({ timeout: 15000 });

    // 1. General Tab
    await page.click('button:has-text("General")');
    await expect(page.locator('h4:has-text("Network Exposure")')).toBeVisible();

    // 2. Provisioning Tab
    await page.click('button:has-text("Provisioning")');
    await expect(page.locator('.bg-slate-950')).toContainText(/synthesis|deploy|cluster|app|native/i, { timeout: 10000 });

    // 3. Container Logs Tab
    await page.click('button:has-text("Container Logs")');
    await expect(page.locator('div:has-text("Active Pods")').first()).toBeVisible({ timeout: 10000 });

    // 4. Helm Status Tab
    if (hasHelm) {
      await page.click('button:has-text("Helm Status")');
      await expect(page.locator('.bg-slate-950')).toContainText(/status:|deployed|helm/i, { timeout: 15000 });
    }

    // 5. Diagnostics Tab
    await page.click('button:has-text("Diagnostics")');
    await expect(page.locator('.bg-slate-950')).toContainText(/POD STATUS|REPLAY|EVENTS/i, { timeout: 15000 });

    // Close Dashboard
    await page.click('button:has(.lucide-x)');
  }

  // HELPER: Resize disk storage
  async function resizeDiskStorage(page: any, name: string, volumeKey: string, targetSize: string) {
    const row = page.locator(`tr:has-text("${name}")`);
    await row.locator('button:has-text("Manage")').click();

    await page.click('button:has-text("Storage")');
    await expect(page.locator('h4:has-text("Storage Volumes Management")')).toBeVisible();

    // Fill new size
    await page.fill(`#vol-size-${volumeKey}`, targetSize);

    // Apply Changes
    await page.click('button:has-text("Apply Changes")');

    // Wait and close resizing logs
    await page.waitForTimeout(5000);
    await page.click('button:has(.lucide-x)');

    // Wait for deployment to re-stabilize to 'running'
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Confirm updated size is reflected
    await row.locator('button:has-text("Manage")').click();
    await page.click('button:has-text("Storage")');
    const volCard = page.locator(`div:has-text("Key: ${volumeKey}")`).first();
    await expect(volCard).toContainText(targetSize);
    await page.click('button:has(.lucide-x)');
  }

  // HELPER: Delete deployment
  async function destroyApplication(page: any, name: string) {
    await page.click('button:has-text("Applications")');
    const row = page.locator(`tr:has-text("${name}")`);
    await row.locator('button:has-text("Destroy")').click();
    await page.click('button:has-text("Confirm Delete")');
    await expect(row).not.toBeVisible({ timeout: 120000 });
  }

  // TEST 1: Provision k3d Cluster
  test('should provision the cluster', async ({ page }) => {
    test.setTimeout(600000); // 10 mins

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Provisioner v2');

    await page.click('button:has-text("Provision Cluster")');
    await page.fill('input[placeholder="e.g. production-omega"]', CLUSTER_NAME);
    await page.selectOption('select', 'k3d');
    await page.click('button:has-text("Start Provisioning")');

    await expect(page.locator('h3:has-text("Execution Tracing")')).toBeVisible({ timeout: 15000 });
    await page.click('button:has(.lucide-x)');

    const clusterCard = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: CLUSTER_NAME }) }).first();
    await expect(clusterCard.locator('span:has-text("healthy")')).toBeVisible({ timeout: 600000 });
  });

  // TEST 2: Deploy & Manage Odoo (Native Strategy)
  test.skip('should deploy and manage Odoo', async ({ page }) => {
    test.setTimeout(900000); // 15 mins
    await page.goto('/');

    const appName = 'Odoo-E2E';
    await deployApplication(page, appName, 'odoo', 'native', true);

    const row = page.locator(`tr:has-text("${appName}")`);
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Logging Tabs (no Helm status)
    await verifyLoggingTabs(page, appName, false);

    // Verify Modules Marketplace
    await row.locator('button:has-text("Manage")').click();
    await page.click('button:has-text("Modules")');
    await expect(page.locator('h4:has-text("Module Marketplace")')).toBeVisible();

    const saleModule = page.locator('button:has-text("Sales Order")').first();
    await saleModule.click();
    await page.click('button:has-text("Apply Changes")');
    await page.waitForTimeout(5000);
    await page.click('button:has(.lucide-x)');

    // Wait to return to running
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Disk Resizing
    await resizeDiskStorage(page, appName, 'db', '3Gi');

    // Destroy app
    await destroyApplication(page, appName);
  });

  // TEST 3: Deploy & Manage WordPress (Native Strategy)
  test('should deploy and manage WordPress', async ({ page }) => {
    test.setTimeout(900000); // 15 mins
    await page.goto('/');

    const appName = 'Wordpress-E2E';
    await deployApplication(page, appName, 'wordpress', 'native', true);

    const row = page.locator(`tr:has-text("${appName}")`);
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Native Logging (no Helm status)
    await verifyLoggingTabs(page, appName, false);

    // Verify Disk Resizing
    await resizeDiskStorage(page, appName, 'db', '3Gi');

    // Destroy app
    await destroyApplication(page, appName);
  });

  // TEST 4: Deploy & Manage Nextcloud (Native Strategy)
  test('should deploy and manage Nextcloud', async ({ page }) => {
    test.setTimeout(900000); // 15 mins
    await page.goto('/');

    const appName = 'Nextcloud-E2E';
    await deployApplication(page, appName, 'nextcloud', 'native', true);

    const row = page.locator(`tr:has-text("${appName}")`);
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Logging Tabs (no Helm status)
    await verifyLoggingTabs(page, appName, false);

    // Verify Disk Resizing of DB
    await resizeDiskStorage(page, appName, 'db', '3Gi');

    // Destroy app
    await destroyApplication(page, appName);
  });

  // TEST 5: Deploy & Manage Audiobookshelf (Native Strategy)
  test('should deploy and manage Audiobookshelf', async ({ page }) => {
    test.setTimeout(900000); // 15 mins
    await page.goto('/');

    const appName = 'Audiobookshelf-E2E';
    await deployApplication(page, appName, 'audiobookshelf', 'native', false);

    const row = page.locator(`tr:has-text("${appName}")`);
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Disk Resizing (Library storage)
    await resizeDiskStorage(page, appName, 'library', '6Gi');

    // Nginx Proxy Wizard E2E Test
    await page.click('button:has-text("Nginx Router")');
    await expect(page.locator('h2:has-text("Nginx Router Settings")')).toBeVisible();
    const textarea = page.locator('textarea');
    await expect(textarea).not.toBeEmpty();
    const originalNginxConfig = await textarea.inputValue();

    try {
      await page.click('button:has-text("Proxy Wizard")');
      await expect(page.locator('h3:has-text("Proxy Exposure Wizard")')).toBeVisible();

      // Step 1: Select App (Wait for the deployments list to load and reactively populate the options)
      const select = page.locator('#nginx-wizard-app');
      const option = select.locator('option', { hasText: 'Audiobookshelf-E2E' });
      await expect(option).toBeAttached({ timeout: 20000 });
      const val = await option.getAttribute('value');
      await select.selectOption(val || '');
      await page.click('button:has-text("Next")');

      // Step 2: Configure Domain
      await expect(page.locator('h4:has-text("Domain & Traffic Settings")')).toBeVisible();
      await page.fill('#nginx-wizard-domain', 'audiobookshelf-e2e.vpn.local');
      await page.click('button:has-text("Next")');

      // Step 3: Review and Inject
      await expect(page.locator('h4:has-text("Review Configuration")')).toBeVisible();
      const generatedPre = page.locator('h3:has-text("Proxy Exposure Wizard")').locator('xpath=../..').locator('pre');
      await expect(generatedPre).toContainText('server_name audiobookshelf-e2e.vpn.local;');
      await page.click('button:has-text("Inject into config & Close")');

      // Save and reload
      await page.click('button:has-text("Save & Reload Nginx")');
      await expect(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 15000 });
    } finally {
      // Restore Nginx configuration to keep tests clean
      try {
        const closeBtn = page.locator('button:has(.lucide-x)').first();
        // Aggressively close any open modals (Wizard modal, log modal, etc.)
        while (await closeBtn.isVisible()) {
          await closeBtn.click();
          await page.waitForTimeout(500);
        }
      } catch {}
      await page.click('button:has-text("Nginx Router")');
      const configTextarea = page.locator('textarea');
      await expect(configTextarea).not.toBeEmpty();
      await configTextarea.fill(originalNginxConfig);
      await page.click('button:has-text("Save & Reload Nginx")');
      await expect(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 15000 });
    }

    // Destroy app
    await destroyApplication(page, appName);
  });

  // TEST 6: Deploy & Manage Prometheus (Helm Strategy)
  test('should deploy and manage Prometheus', async ({ page }) => {
    test.setTimeout(900000); // 15 mins
    await page.goto('/');

    const appName = 'Prometheus-E2E';
    await deployApplication(page, appName, 'prometheus', 'helm', false);

    const row = page.locator(`tr:has-text("${appName}")`);
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Disk Resizing of Metrics Server
    await resizeDiskStorage(page, appName, 'server', '12Gi');

    // Destroy app
    await destroyApplication(page, appName);
  });

  // TEST 7: Deploy & Manage Traefik (Helm Strategy)
  test('should deploy and manage Traefik', async ({ page }) => {
    test.setTimeout(900000); // 15 mins
    await page.goto('/');

    const appName = 'Traefik-E2E';
    await deployApplication(page, appName, 'traefik', 'helm', false);

    const row = page.locator(`tr:has-text("${appName}")`);
    await expect(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // Verify Storage tab shows 'No Volumes Configured'
    await row.locator('button:has-text("Manage")').click();
    await page.click('button:has-text("Storage")');
    await expect(page.locator('h5:has-text("No Volumes Configured")')).toBeVisible();
    await page.click('button:has(.lucide-x)');

    // Destroy app
    await destroyApplication(page, appName);
  });

  // TEST 8: Destroy the k3d cluster
  test('should clean up the cluster', async ({ page }) => {
    test.setTimeout(300000); // 5 mins
    await page.goto('/');

    await page.click('button:has-text("Clusters")');
    const clusterCard = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: CLUSTER_NAME }) }).first();
    await clusterCard.locator('button.text-red-400').click();
    await page.click('button:has-text("Confirm Delete")');

    // Close logs modal
    await expect(page.locator('h3:has-text("Execution Tracing")')).toBeVisible({ timeout: 15000 });
    await page.click('button:has(.lucide-x)');
    await expect(clusterCard).not.toBeVisible({ timeout: 120000 });
  });

  // TEST 9: Detect cluster and application destruction outside the system
  test('should clean up UI and DB when cluster is destroyed outside the system', async ({ page }) => {
    test.setTimeout(600000); // 10 mins
    await page.goto('/');

    // 1. Provision a new temporary cluster via the UI
    const TEMP_CLUSTER = `e2e-sync-${Math.floor(Math.random() * 1000)}`;
    await page.click('button:has-text("Clusters")');
    await page.click('button:has-text("Provision Cluster")');
    await page.fill('input[placeholder="e.g. production-omega"]', TEMP_CLUSTER);
    await page.selectOption('select', 'k3d');
    await page.click('button:has-text("Start Provisioning")');

    // Wait for the provisioning modal to show and close it
    await expect(page.locator('h3:has-text("Execution Tracing")')).toBeVisible({ timeout: 15000 });
    await page.click('button:has(.lucide-x)');

    // Wait for cluster to become healthy
    const clusterCard = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: TEMP_CLUSTER }) }).first();
    await expect(clusterCard.locator('span:has-text("healthy")')).toBeVisible({ timeout: 600000 });

    // 2. Deploy an application to this cluster
    const TEMP_APP = `e2e-sync-app-${Math.floor(Math.random() * 1000)}`;
    await deployApplication(page, TEMP_APP, 'audiobookshelf', 'native', false, TEMP_CLUSTER);

    // Verify application is running
    const appRow = page.locator(`tr:has-text("${TEMP_APP}")`);
    await expect(appRow.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });

    // 3. Destroy the physical k3d cluster OUTSIDE the system (via direct CLI command)
    console.log(`🔨 Deleting physical cluster ${TEMP_CLUSTER} outside the system...`);
    try {
      execSync(`./bin/k3d cluster delete ${TEMP_CLUSTER}`, { stdio: 'inherit' });
    } catch (e: any) {
      console.error(`Failed to delete physical cluster: ${e.message}`);
    }

    // 4. Reload the page (forces refresh and triggers backend sync)
    await page.reload();

    // 5. Verify the cluster is NO LONGER visible in the UI
    await page.click('button:has-text("Clusters")');
    const clusterCardAfter = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: TEMP_CLUSTER }) }).first();
    await expect(clusterCardAfter).not.toBeVisible({ timeout: 15000 });

    // 6. Verify the application is NO LONGER visible in the UI
    await page.click('button:has-text("Applications")');
    const appRowAfter = page.locator(`tr:has-text("${TEMP_APP}")`);
    await expect(appRowAfter).not.toBeVisible({ timeout: 15000 });
  });

  // TEST 10: View and Edit Nginx configuration
  test('should view, edit, and restore Nginx configuration', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Nginx Router")');

    // Verify page header
    await expect(page.locator('h2:has-text("Nginx Router Settings")')).toBeVisible();

    // Verify textarea loads configuration
    const textarea = page.locator('textarea');
    await expect(textarea).not.toBeEmpty();

    // Check configuration content
    const originalContent = await textarea.inputValue();
    expect(originalContent).toContain('http {');

    try {
      // Edit content to modify upload size or add max body size
      const newContent = originalContent.includes('client_max_body_size')
        ? originalContent.replace(/client_max_body_size\s+\w+;/g, 'client_max_body_size 20G;')
        : originalContent.replace(
            'keepalive_timeout  65;',
            'keepalive_timeout  65;\n    client_max_body_size 10G;'
          );
      await textarea.fill(newContent);

      // Save configuration
      await page.click('button:has-text("Save & Reload Nginx")');

      // Verify success banner is shown
      await expect(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 10000 });

      // Reload page and verify changes persist
      await page.reload();
      await page.click('button:has-text("Nginx Router")');
      const updatedContent = await textarea.inputValue();
      const expectedValue = originalContent.includes('client_max_body_size') ? 'client_max_body_size 20G;' : 'client_max_body_size 10G;';
      expect(updatedContent).toContain(expectedValue);
    } finally {
      // Restore configuration to clean up
      await page.goto('/');
      await page.click('button:has-text("Nginx Router")');
      const currentText = await textarea.inputValue();
      if (currentText !== originalContent) {
        await textarea.fill(originalContent);
        await page.click('button:has-text("Save & Reload Nginx")');
        await expect(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 10000 });
      }
    }
  });
});
