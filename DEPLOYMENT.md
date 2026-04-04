# DEPLOYMENT.md — Marketing MCP Server on AWS EC2

> **Goal:** Deploy the MCP server on a fresh Ubuntu 24.04 EC2 instance, expose it via HTTPS through Nginx + Let's Encrypt, and connect it to Claude.ai as a Remote MCP Server.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| AWS EC2 instance | `t3.small` (2 vCPU, 2 GB RAM) minimum. Ubuntu 24.04 LTS AMI. |
| Elastic IP | Attach a static Elastic IP to the instance. |
| Domain name | Point an **A record** to your Elastic IP (e.g. `mcp.yourdomain.com`). Claude requires HTTPS. |
| Security Group | Inbound: TCP 22 (SSH), 80 (HTTP), 443 (HTTPS). Outbound: All. |
| SSH Key Pair | Your `.pem` file downloaded from AWS. |

---

## Step 1 — SSH Into the EC2 Instance

```bash
# From your local machine:
chmod 400 ~/Downloads/your-key.pem

ssh -i ~/Downloads/your-key.pem ubuntu@YOUR_ELASTIC_IP
```

---

## Step 2 — System Update & Install Node.js 20 LTS

```bash
# Update package index
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v    # should print v20.x.x
npm -v     # should print 10.x.x
```

---

## Step 3 — Install MongoDB 7 Community

```bash
# Import MongoDB GPG key
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

# Add MongoDB repo
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

sudo apt update
sudo apt install -y mongodb-org

# Start & enable on boot
sudo systemctl start mongod
sudo systemctl enable mongod

# Verify
sudo systemctl status mongod   # Should show: active (running)
```

---

## Step 4 — Install PM2 (Process Manager)

```bash
sudo npm install -g pm2

# Configure PM2 to start on system boot
pm2 startup systemd
# → Copy and run the command that PM2 outputs (it starts with "sudo env PATH=...")
```

---

## Step 5 — Clone the Repository & Install Dependencies

```bash
# Install Git if not present
sudo apt install -y git

# Clone your repo (replace with your actual repo URL)
git clone https://github.com/YOUR_USERNAME/marketing-mcp-server.git /home/ubuntu/marketing-mcp

cd /home/ubuntu/marketing-mcp

# Install Node dependencies
npm install

# Build TypeScript
npm run build
```

---

## Step 6 — Configure Environment Variables

```bash
# Copy the example env file
cp .env.example .env

# Edit with your actual values
nano .env
```

Fill in **all** required values:

```dotenv
PORT=3000
NODE_ENV=production
MONGODB_URI=mongodb://127.0.0.1:27017/marketing_mcp

PERPLEXITY_API_KEY=pplx-xxxx          # https://www.perplexity.ai/settings/api
TWITTER_BEARER_TOKEN=xxxxxxxx          # https://developer.twitter.com
LINKEDIN_ACCESS_TOKEN=xxxxxxxx         # https://www.linkedin.com/developers
LINKEDIN_ORGANIZATION_URN=urn:li:organization:XXXXXXX
BEEHIIV_API_KEY=xxxxxxxx               # https://app.beehiiv.com/settings
BEEHIIV_PUBLICATION_ID=pub_xxxxxxxx
NOTION_API_KEY=secret_xxxxxxxx         # https://www.notion.so/my-integrations
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# IMPORTANT: Generate a strong random secret, e.g.:
# openssl rand -hex 32
MCP_AUTH_SECRET=your-strong-random-secret-here
```

> ⚠️ **Security:** `MCP_AUTH_SECRET` is the bearer token Claude.ai will include in every request. Keep it secret.

---

## Step 7 — Start the Server with PM2

```bash
cd /home/ubuntu/marketing-mcp

# Start using the PM2 ecosystem config
pm2 start ecosystem.config.yml --env production

# Save PM2 process list (survives reboots)
pm2 save

# Check status
pm2 status
pm2 logs marketing-mcp --lines 50
```

**Quick health check:**
```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","server":"marketing-mcp-server",...}
```

---

## Step 8 — Install Nginx as Reverse Proxy

```bash
sudo apt install -y nginx

# Remove the default site
sudo rm /etc/nginx/sites-enabled/default
```

Create the Nginx config for your domain:

```bash
sudo nano /etc/nginx/sites-available/mcp.yourdomain.com
```

Paste the following (replace `mcp.yourdomain.com` with your domain):

```nginx
server {
    listen 80;
    server_name mcp.yourdomain.com;

    # Will be extended by Certbot for HTTPS
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required for SSE (Server-Sent Events) — do NOT buffer!
        proxy_set_header   Connection        '';
        proxy_set_header   Cache-Control     'no-cache';
        proxy_set_header   X-Accel-Buffering 'no';
        proxy_buffering    off;
        chunked_transfer_encoding on;

        # Standard proxy headers
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE connections need longer timeouts
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable the site and test:

```bash
sudo ln -s /etc/nginx/sites-available/mcp.yourdomain.com \
           /etc/nginx/sites-enabled/mcp.yourdomain.com

sudo nginx -t          # Should print: syntax is ok
sudo systemctl restart nginx
```

---

## Step 9 — Enable HTTPS with Let's Encrypt (Certbot)

> Claude.ai **requires** HTTPS for all remote MCP connections.

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain and auto-install the SSL certificate
sudo certbot --nginx -d mcp.yourdomain.com

# Follow prompts:
#  - Enter your email address
#  - Agree to terms
#  - Choose "Redirect HTTP to HTTPS" (option 2)

# Verify auto-renewal works
sudo certbot renew --dry-run
```

Certbot will automatically modify your Nginx config to add the HTTPS server block.

---

## Step 10 — Verify End-to-End

```bash
# From your local machine or browser:
curl https://mcp.yourdomain.com/health
# Expected: {"status":"ok",...}

# Test SSE endpoint auth
curl -H "Authorization: Bearer your-strong-random-secret-here" \
     https://mcp.yourdomain.com/sse
# Expected: SSE stream begins (text/event-stream)
```

---

## Step 11 — Connect Claude.ai as Orchestrator

1. Go to **Claude.ai → Projects → Your Project → Settings**.
2. Click **Add MCP Server** → **Remote**.
3. Fill in:
   | Field | Value |
   |---|---|
   | **Server URL** | `https://mcp.yourdomain.com/sse` |
   | **Authentication** | Bearer Token |
   | **Token** | Your `MCP_AUTH_SECRET` value |
4. Click **Connect**. Claude should list all 4 tools:
   - `execute_research`
   - `save_draft_content`
   - `publish_approved_content`
   - `sync_analytics_to_notion`

---

## Useful PM2 Commands

```bash
pm2 status                          # View all processes
pm2 logs marketing-mcp --lines 100  # Tail logs
pm2 restart marketing-mcp           # Restart server
pm2 stop marketing-mcp              # Stop server
pm2 delete marketing-mcp            # Remove from PM2

# After pulling new code:
git pull && npm run build && pm2 restart marketing-mcp
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Claude can't connect | Verify Security Group allows TCP 443. Check `sudo nginx -t`. |
| SSE drops after 60s | Ensure `proxy_read_timeout 3600s` is in Nginx config. |
| MongoDB not connecting | `sudo systemctl status mongod` — confirm it's running. |
| 401 Unauthorized | Double-check `MCP_AUTH_SECRET` in `.env` matches what Claude sends. |
| TypeScript build fails | Run `npm run build` locally first and fix errors before pushing. |
| Certbot fails | Ensure port 80 is open in Security Group and DNS A record is resolving. |

---

## Security Hardening (Recommended)

```bash
# 1. Enable UFW firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable

# 2. Disable password SSH — use keys only
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no
sudo systemctl restart sshd

# 3. Set up automatic security updates
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades

# 4. Restrict MongoDB to localhost only (already default)
# Confirm in /etc/mongod.conf:
#   net:
#     bindIp: 127.0.0.1
```

---

*Last updated: April 2026 — Marketing MCP Server v1.0.0*
