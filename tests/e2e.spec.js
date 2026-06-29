"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
test_1.test.describe('Provisioning Platform E2E Suite', () => {
    const CLUSTER_NAME = `e2e-fleet-${Math.floor(Math.random() * 1000)}`;
    test_1.test.beforeAll(async () => {
        console.log(`🚀 Starting E2E test suite for cluster: ${CLUSTER_NAME}`);
        try {
            console.log('Stopping k3d-Lunorica-local-server-0 to avoid hostnetwork conflicts...');
            (0, child_process_1.execSync)('docker stop k3d-Lunorica-local-server-0', { stdio: 'inherit' });
        }
        catch (e) {
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
            (0, child_process_1.execSync)('docker exec provisioner-nginx nginx -s reload', { stdio: 'inherit' });
        }
        catch (e) {
            console.error(`Failed to reset nginx.conf: ${e.message}`);
        }
    });
    test_1.test.afterAll(async () => {
        console.log(`🧹 E2E afterAll: Cleaning up cluster ${CLUSTER_NAME}...`);
        try {
            (0, child_process_1.execSync)(`./bin/k3d cluster delete ${CLUSTER_NAME}`, { stdio: 'inherit' });
        }
        catch (e) {
            console.error(`Failed to delete cluster in afterAll: ${e.message}`);
        }
        try {
            console.log('Restarting k3d-Lunorica-local-server-0...');
            (0, child_process_1.execSync)('docker start k3d-Lunorica-local-server-0', { stdio: 'inherit' });
        }
        catch (e) {
            console.error(`Failed to restart local cluster: ${e.message}`);
        }
    });
    // HELPER: Deploy an application using the wizard
    async function deployApplication(page, name, appType, strategy, isDbApp, clusterName) {
        await page.click('button:has-text("Applications")');
        await page.click('button:has-text("Deploy App")');
        // Step 1: Base Configuration
        const targetCluster = clusterName || CLUSTER_NAME;
        const option = page.locator(`#wizard-target-cluster option:has-text("${targetCluster}")`);
        const optionValue = await option.getAttribute('value');
        await page.selectOption('#wizard-target-cluster', optionValue || '');
        await page.selectOption('#wizard-app-type', appType);
        await page.fill('#wizard-instance-name', name);
        await (0, test_1.expect)(page.locator('button:has-text("Next")')).toBeEnabled();
        await page.click('button:has-text("Next")');
        // Step 2: Deployment Strategy
        if (strategy === 'helm') {
            await page.click('button:has-text("Helm Chart")');
        }
        else {
            await page.click('button:has-text("Native K8s")');
        }
        await (0, test_1.expect)(page.locator('button:has-text("Next")')).toBeEnabled();
        await page.click('button:has-text("Next")');
        // Step 3: Windscribe VPN Routing (Only for native strategy)
        if (strategy === 'native') {
            await (0, test_1.expect)(page.locator('h4:has-text("Windscribe VPN Routing")')).toBeVisible();
            await (0, test_1.expect)(page.locator('button:has-text("Next")')).toBeEnabled();
            await page.click('button:has-text("Next")');
        }
        // Step 4: Component Version (Main App)
        await page.waitForSelector('button:has-text("Next")');
        await (0, test_1.expect)(page.locator('button:has-text("Next")')).toBeEnabled();
        await page.click('button:has-text("Next")');
        // Step 5: Component Version (Database)
        if (isDbApp) {
            await page.waitForSelector('button:has-text("Next")');
            await (0, test_1.expect)(page.locator('button:has-text("Next")')).toBeEnabled();
            await page.click('button:has-text("Next")');
        }
        // Step 6: Confirm and Initiate
        await (0, test_1.expect)(page.locator('button:has-text("Initiate Deployment")')).toBeEnabled();
        await page.click('button:has-text("Initiate Deployment")');
        // Monitor trace and close logs modal
        await (0, test_1.expect)(page.locator('h3:has-text("Dashboard")')).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(5000);
        await page.click('button:has(.lucide-x)');
    }
    // HELPER: Verify the 5 dashboard logging tabs
    async function verifyLoggingTabs(page, name, hasHelm) {
        const row = page.locator(`tr:has-text("${name}")`);
        await row.locator('button:has-text("Manage")').click();
        // Verify modal title
        await (0, test_1.expect)(page.locator(`h3:has-text("${name} Dashboard")`)).toBeVisible({ timeout: 15000 });
        // 1. General Tab
        await page.click('button:has-text("General")');
        await (0, test_1.expect)(page.locator('h4:has-text("Network Exposure")')).toBeVisible();
        // 2. Provisioning Tab
        await page.click('button:has-text("Provisioning")');
        await (0, test_1.expect)(page.locator('.bg-slate-950')).toContainText(/synthesis|deploy|cluster|app|native/i, { timeout: 10000 });
        // 3. Container Logs Tab
        await page.click('button:has-text("Container Logs")');
        await (0, test_1.expect)(page.locator('div:has-text("Active Pods")').first()).toBeVisible({ timeout: 10000 });
        // 4. Helm Status Tab
        if (hasHelm) {
            await page.click('button:has-text("Helm Status")');
            await (0, test_1.expect)(page.locator('.bg-slate-950')).toContainText(/status:|deployed|helm/i, { timeout: 15000 });
        }
        // 5. Diagnostics Tab
        await page.click('button:has-text("Diagnostics")');
        await (0, test_1.expect)(page.locator('.bg-slate-950')).toContainText(/POD STATUS|REPLAY|EVENTS/i, { timeout: 15000 });
        // Close Dashboard
        await page.click('button:has(.lucide-x)');
    }
    // HELPER: Resize disk storage
    async function resizeDiskStorage(page, name, volumeKey, targetSize) {
        const row = page.locator(`tr:has-text("${name}")`);
        await row.locator('button:has-text("Manage")').click();
        await page.click('button:has-text("Storage")');
        await (0, test_1.expect)(page.locator('h4:has-text("Storage Volumes Management")')).toBeVisible();
        // Fill new size
        await page.fill(`#vol-size-${volumeKey}`, targetSize);
        // Apply Changes
        await page.click('button:has-text("Apply Changes")');
        // Wait and close resizing logs
        await page.waitForTimeout(5000);
        await page.click('button:has(.lucide-x)');
        // Wait for deployment to re-stabilize to 'running'
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Confirm updated size is reflected
        await row.locator('button:has-text("Manage")').click();
        await page.click('button:has-text("Storage")');
        const volCard = page.locator(`div:has-text("Key: ${volumeKey}")`).first();
        await (0, test_1.expect)(volCard).toContainText(targetSize);
        await page.click('button:has(.lucide-x)');
    }
    // HELPER: Delete deployment
    async function destroyApplication(page, name) {
        await page.click('button:has-text("Applications")');
        const row = page.locator(`tr:has-text("${name}")`);
        await row.locator('button:has-text("Destroy")').click();
        await page.click('button:has-text("Confirm Delete")');
        await (0, test_1.expect)(row).not.toBeVisible({ timeout: 120000 });
    }
    // TEST 1: Provision k3d Cluster
    (0, test_1.test)('should provision the cluster', async ({ page }) => {
        test_1.test.setTimeout(600000); // 10 mins
        await page.goto('/');
        await (0, test_1.expect)(page.locator('h1')).toContainText('Provisioner v2');
        await page.click('button:has-text("Provision Cluster")');
        await page.fill('input[placeholder="e.g. production-omega"]', CLUSTER_NAME);
        await page.selectOption('select', 'k3d');
        await page.click('button:has-text("Start Provisioning")');
        await (0, test_1.expect)(page.locator('h3:has-text("Execution Tracing")')).toBeVisible({ timeout: 15000 });
        await page.click('button:has(.lucide-x)');
        const clusterCard = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: CLUSTER_NAME }) }).first();
        await (0, test_1.expect)(clusterCard.locator('span:has-text("healthy")')).toBeVisible({ timeout: 600000 });
    });
    // TEST 2: Deploy & Manage Odoo (Native Strategy)
    test_1.test.skip('should deploy and manage Odoo', async ({ page }) => {
        test_1.test.setTimeout(900000); // 15 mins
        await page.goto('/');
        const appName = 'Odoo-E2E';
        await deployApplication(page, appName, 'odoo', 'native', true);
        const row = page.locator(`tr:has-text("${appName}")`);
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Logging Tabs (no Helm status)
        await verifyLoggingTabs(page, appName, false);
        // Verify Modules Marketplace
        await row.locator('button:has-text("Manage")').click();
        await page.click('button:has-text("Modules")');
        await (0, test_1.expect)(page.locator('h4:has-text("Module Marketplace")')).toBeVisible();
        const saleModule = page.locator('button:has-text("Sales Order")').first();
        await saleModule.click();
        await page.click('button:has-text("Apply Changes")');
        await page.waitForTimeout(5000);
        await page.click('button:has(.lucide-x)');
        // Wait to return to running
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Disk Resizing
        await resizeDiskStorage(page, appName, 'db', '3Gi');
        // Destroy app
        await destroyApplication(page, appName);
    });
    // TEST 3: Deploy & Manage WordPress (Native Strategy)
    (0, test_1.test)('should deploy and manage WordPress', async ({ page }) => {
        test_1.test.setTimeout(900000); // 15 mins
        await page.goto('/');
        const appName = 'Wordpress-E2E';
        await deployApplication(page, appName, 'wordpress', 'native', true);
        const row = page.locator(`tr:has-text("${appName}")`);
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Native Logging (no Helm status)
        await verifyLoggingTabs(page, appName, false);
        // Verify Disk Resizing
        await resizeDiskStorage(page, appName, 'db', '3Gi');
        // Destroy app
        await destroyApplication(page, appName);
    });
    // TEST 4: Deploy & Manage Nextcloud (Native Strategy)
    (0, test_1.test)('should deploy and manage Nextcloud', async ({ page }) => {
        test_1.test.setTimeout(900000); // 15 mins
        await page.goto('/');
        const appName = 'Nextcloud-E2E';
        await deployApplication(page, appName, 'nextcloud', 'native', true);
        const row = page.locator(`tr:has-text("${appName}")`);
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Logging Tabs (no Helm status)
        await verifyLoggingTabs(page, appName, false);
        // Verify Disk Resizing of DB
        await resizeDiskStorage(page, appName, 'db', '3Gi');
        // Destroy app
        await destroyApplication(page, appName);
    });
    // TEST 5: Deploy & Manage Audiobookshelf (Native Strategy)
    (0, test_1.test)('should deploy and manage Audiobookshelf', async ({ page }) => {
        test_1.test.setTimeout(900000); // 15 mins
        await page.goto('/');
        const appName = 'Audiobookshelf-E2E';
        await deployApplication(page, appName, 'audiobookshelf', 'native', false);
        const row = page.locator(`tr:has-text("${appName}")`);
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Disk Resizing (Library storage)
        await resizeDiskStorage(page, appName, 'library', '6Gi');
        // Nginx Proxy Wizard E2E Test
        await page.click('button:has-text("Nginx Router")');
        await (0, test_1.expect)(page.locator('h2:has-text("Nginx Router Settings")')).toBeVisible();
        const textarea = page.locator('textarea');
        await (0, test_1.expect)(textarea).not.toBeEmpty();
        const originalNginxConfig = await textarea.inputValue();
        try {
            await page.click('button:has-text("Proxy Wizard")');
            await (0, test_1.expect)(page.locator('h3:has-text("Proxy Exposure Wizard")')).toBeVisible();
            // Step 1: Select App (Wait for the deployments list to load and reactively populate the options)
            const select = page.locator('#nginx-wizard-app');
            const option = select.locator('option', { hasText: 'Audiobookshelf-E2E' });
            await (0, test_1.expect)(option).toBeAttached({ timeout: 20000 });
            const val = await option.getAttribute('value');
            await select.selectOption(val || '');
            await page.click('button:has-text("Next")');
            // Step 2: Configure Domain
            await (0, test_1.expect)(page.locator('h4:has-text("Domain & Traffic Settings")')).toBeVisible();
            await page.fill('#nginx-wizard-domain', 'audiobookshelf-e2e.vpn.local');
            await page.click('button:has-text("Next")');
            // Step 3: Review and Inject
            await (0, test_1.expect)(page.locator('h4:has-text("Review Configuration")')).toBeVisible();
            const generatedPre = page.locator('h3:has-text("Proxy Exposure Wizard")').locator('xpath=../..').locator('pre');
            await (0, test_1.expect)(generatedPre).toContainText('server_name audiobookshelf-e2e.vpn.local;');
            await page.click('button:has-text("Inject into config & Close")');
            // Save and reload
            await page.click('button:has-text("Save & Reload Nginx")');
            await (0, test_1.expect)(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 15000 });
        }
        finally {
            // Restore Nginx configuration to keep tests clean
            try {
                const closeBtn = page.locator('button:has(.lucide-x)').first();
                // Aggressively close any open modals (Wizard modal, log modal, etc.)
                while (await closeBtn.isVisible()) {
                    await closeBtn.click();
                    await page.waitForTimeout(500);
                }
            }
            catch { }
            await page.click('button:has-text("Nginx Router")');
            const configTextarea = page.locator('textarea');
            await (0, test_1.expect)(configTextarea).not.toBeEmpty();
            await configTextarea.fill(originalNginxConfig);
            await page.click('button:has-text("Save & Reload Nginx")');
            await (0, test_1.expect)(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 15000 });
        }
        // Destroy app
        await destroyApplication(page, appName);
    });
    // TEST 6: Deploy & Manage Prometheus (Helm Strategy)
    (0, test_1.test)('should deploy and manage Prometheus', async ({ page }) => {
        test_1.test.setTimeout(900000); // 15 mins
        await page.goto('/');
        const appName = 'Prometheus-E2E';
        await deployApplication(page, appName, 'prometheus', 'helm', false);
        const row = page.locator(`tr:has-text("${appName}")`);
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Disk Resizing of Metrics Server
        await resizeDiskStorage(page, appName, 'server', '12Gi');
        // Destroy app
        await destroyApplication(page, appName);
    });
    // TEST 7: Deploy & Manage Traefik (Helm Strategy)
    (0, test_1.test)('should deploy and manage Traefik', async ({ page }) => {
        test_1.test.setTimeout(900000); // 15 mins
        await page.goto('/');
        const appName = 'Traefik-E2E';
        await deployApplication(page, appName, 'traefik', 'helm', false);
        const row = page.locator(`tr:has-text("${appName}")`);
        await (0, test_1.expect)(row.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // Verify Storage tab shows 'No Volumes Configured'
        await row.locator('button:has-text("Manage")').click();
        await page.click('button:has-text("Storage")');
        await (0, test_1.expect)(page.locator('h5:has-text("No Volumes Configured")')).toBeVisible();
        await page.click('button:has(.lucide-x)');
        // Destroy app
        await destroyApplication(page, appName);
    });
    // TEST 8: Destroy the k3d cluster
    (0, test_1.test)('should clean up the cluster', async ({ page }) => {
        test_1.test.setTimeout(300000); // 5 mins
        await page.goto('/');
        await page.click('button:has-text("Clusters")');
        const clusterCard = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: CLUSTER_NAME }) }).first();
        await clusterCard.locator('button.text-red-400').click();
        await page.click('button:has-text("Confirm Delete")');
        // Close logs modal
        await (0, test_1.expect)(page.locator('h3:has-text("Execution Tracing")')).toBeVisible({ timeout: 15000 });
        await page.click('button:has(.lucide-x)');
        await (0, test_1.expect)(clusterCard).not.toBeVisible({ timeout: 120000 });
    });
    // TEST 9: Detect cluster and application destruction outside the system
    (0, test_1.test)('should clean up UI and DB when cluster is destroyed outside the system', async ({ page }) => {
        test_1.test.setTimeout(600000); // 10 mins
        await page.goto('/');
        // 1. Provision a new temporary cluster via the UI
        const TEMP_CLUSTER = `e2e-sync-${Math.floor(Math.random() * 1000)}`;
        await page.click('button:has-text("Clusters")');
        await page.click('button:has-text("Provision Cluster")');
        await page.fill('input[placeholder="e.g. production-omega"]', TEMP_CLUSTER);
        await page.selectOption('select', 'k3d');
        await page.click('button:has-text("Start Provisioning")');
        // Wait for the provisioning modal to show and close it
        await (0, test_1.expect)(page.locator('h3:has-text("Execution Tracing")')).toBeVisible({ timeout: 15000 });
        await page.click('button:has(.lucide-x)');
        // Wait for cluster to become healthy
        const clusterCard = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: TEMP_CLUSTER }) }).first();
        await (0, test_1.expect)(clusterCard.locator('span:has-text("healthy")')).toBeVisible({ timeout: 600000 });
        // 2. Deploy an application to this cluster
        const TEMP_APP = `e2e-sync-app-${Math.floor(Math.random() * 1000)}`;
        await deployApplication(page, TEMP_APP, 'audiobookshelf', 'native', false, TEMP_CLUSTER);
        // Verify application is running
        const appRow = page.locator(`tr:has-text("${TEMP_APP}")`);
        await (0, test_1.expect)(appRow.locator('span:has-text("running")')).toBeVisible({ timeout: 600000 });
        // 3. Destroy the physical k3d cluster OUTSIDE the system (via direct CLI command)
        console.log(`🔨 Deleting physical cluster ${TEMP_CLUSTER} outside the system...`);
        try {
            (0, child_process_1.execSync)(`./bin/k3d cluster delete ${TEMP_CLUSTER}`, { stdio: 'inherit' });
        }
        catch (e) {
            console.error(`Failed to delete physical cluster: ${e.message}`);
        }
        // 4. Reload the page (forces refresh and triggers backend sync)
        await page.reload();
        // 5. Verify the cluster is NO LONGER visible in the UI
        await page.click('button:has-text("Clusters")');
        const clusterCardAfter = page.locator('.bg-slate-800').filter({ has: page.locator('h4', { hasText: TEMP_CLUSTER }) }).first();
        await (0, test_1.expect)(clusterCardAfter).not.toBeVisible({ timeout: 15000 });
        // 6. Verify the application is NO LONGER visible in the UI
        await page.click('button:has-text("Applications")');
        const appRowAfter = page.locator(`tr:has-text("${TEMP_APP}")`);
        await (0, test_1.expect)(appRowAfter).not.toBeVisible({ timeout: 15000 });
    });
    // TEST 10: View and Edit Nginx configuration
    (0, test_1.test)('should view, edit, and restore Nginx configuration', async ({ page }) => {
        await page.goto('/');
        await page.click('button:has-text("Nginx Router")');
        // Verify page header
        await (0, test_1.expect)(page.locator('h2:has-text("Nginx Router Settings")')).toBeVisible();
        // Verify textarea loads configuration
        const textarea = page.locator('textarea');
        await (0, test_1.expect)(textarea).not.toBeEmpty();
        // Check configuration content
        const originalContent = await textarea.inputValue();
        (0, test_1.expect)(originalContent).toContain('http {');
        try {
            // Edit content to modify upload size or add max body size
            const newContent = originalContent.includes('client_max_body_size')
                ? originalContent.replace(/client_max_body_size\s+\w+;/g, 'client_max_body_size 20G;')
                : originalContent.replace('keepalive_timeout  65;', 'keepalive_timeout  65;\n    client_max_body_size 10G;');
            await textarea.fill(newContent);
            // Save configuration
            await page.click('button:has-text("Save & Reload Nginx")');
            // Verify success banner is shown
            await (0, test_1.expect)(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 10000 });
            // Reload page and verify changes persist
            await page.reload();
            await page.click('button:has-text("Nginx Router")');
            const updatedContent = await textarea.inputValue();
            const expectedValue = originalContent.includes('client_max_body_size') ? 'client_max_body_size 20G;' : 'client_max_body_size 10G;';
            (0, test_1.expect)(updatedContent).toContain(expectedValue);
        }
        finally {
            // Restore configuration to clean up
            await page.goto('/');
            await page.click('button:has-text("Nginx Router")');
            const currentText = await textarea.inputValue();
            if (currentText !== originalContent) {
                await textarea.fill(originalContent);
                await page.click('button:has-text("Save & Reload Nginx")');
                await (0, test_1.expect)(page.locator('text=Nginx configuration saved and reloaded successfully!')).toBeVisible({ timeout: 10000 });
            }
        }
    });
});
//# sourceMappingURL=e2e.spec.js.map