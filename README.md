# 🚀 Multi-Cloud Provisioning Platform

A simple, local-first platform to spin up Kubernetes clusters and deploy production-ready applications (like Odoo, WordPress, and Nextcloud) with instant public internet access—**no port forwarding or dynamic DNS configuration required**.

---

## 🛠️ Step 1: Prerequisites

Before running the platform, ensure you have the following tool installed:

1. **Node.js (v20 or higher)**: The runtime environment for the platform.
   - **Mac**: Install via [Homebrew](https://brew.sh/) (`brew install node`).
   - **Linux**: Install via [nvm](https://github.com/nvm-sh/nvm) or your package manager.
2. **Container Engine (Optional)**: A runtime is required to host the clusters. However, **our setup script can automatically install and run this for you**:
   - **Mac**: Installs **Colima** (fully open-source) via Homebrew.
   - **Linux**: Installs **Docker CE** (open-source Engine) via the official setup script.

> [!NOTE]
> All other infrastructure binaries (`k3d`, `kubectl`, `helm`, `terraform`) are pre-bundled inside the repository's `bin/` directory.

---

## ⚡ Step 2: Get Started in 3 Steps

Open your terminal and run the following commands:

### 1. Clone the repository and navigate inside
```bash
git clone <your-repository-url>
cd provisioning
```

### 2. Run the first-time setup script
```bash
npm run setup
```
*(This script installs dependencies, configures your open-source container runtime, downloads pre-bundled binaries, and prepares the Kubernetes environment).*

### 3. Start the platform
```bash
npm run dev
```

Once the startup processes complete, open your browser and navigate to:
👉 **[http://localhost:5173](http://localhost:5173)**

---

## 🌐 How to Deploy and Expose Your First App

Here is how to run an application (like Odoo) and share it on the internet:

1. **Create a Cluster**:
   - On the dashboard, click **Create Cluster**.
   - Pick a name (e.g., `my-local-cluster`), choose **k3d** as the provider, and click **Create**.
   - A drawer will slide open showing real-time setup logs. Wait for it to show `running`.

2. **Deploy Odoo**:
   - Click **Deploy App** in the upper right.
   - Select your newly created cluster.
   - Set the name to `odoo-local`, choose **Odoo** as the application type, and select **Native** strategy.
   - Click **Initiate Deployment**. You will see the deployment logs stream live.

3. **Expose It to the Internet**:
   - Once running, go to the application card on your dashboard.
   - Click the **Expose Application** button.
   - A public address (e.g., `https://xxxx-xxxx-xx.loca.lt`) will appear.

4. **Access the Application**:
   - Click the public link.
   - **Localtunnel Warning Screen**: Since this is a public link, localtunnel displays a phishing warning.
   - Simply type in your current public IP address (you can find it by googling "what is my IP" or looking at the dashboard helper text) and click **Click to Continue**.
   - Your Odoo app will load!

5. **Customize the Path (Optional)**:
   - If you want the URL to go straight to Odoo's login page, type `/odoo` in the **Target Route Path** input card and hit `Enter` to save.

---

## 🧹 Useful Commands

If you need to stop services or clean up:

- **Reset Dev Servers**: `npm run clean-dev` (stops all background workers, frontend/backend servers, and active tunnels).
- **Run Tests**: `npm run test` (executes unit tests and Playwright browser integration tests).
