# Production Infrastructure Runbook — Single-VPS k3s

A hardened, reproducible walkthrough to stand up a **real production** stack on a single VPS:

**Traefik** (ingress + TLS) · **cert-manager** (Let's Encrypt) · **CloudNativePG** (Postgres with
continuous backup to **Tigris**) · **Valkey** (official image) · your **Go API**, with
**Pulumi** bootstrapping the cluster and **Argo CD** delivering app workloads from Git. Secrets live
in **Infisical** and are injected via its Kubernetes Operator. The Kubernetes API is private behind
**WireGuard**.

> **Single-node reality check.** One VPS cannot survive its own failure — there is no true HA here.
> What this runbook *does* guarantee: no data loss (off-node backups + PITR), no plaintext secrets,
> a locked-down host, and a layout you can scale to multiple nodes later without re-architecting.
> Where a choice would block that growth, it's called out.

---

## Table of contents

1. [Architecture](#1-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Host hardening (before k3s)](#3-host-hardening-before-k3s)
4. [WireGuard (private admin plane)](#4-wireguard-private-admin-plane)
5. [Install k3s](#5-install-k3s)
6. [Pulumi bootstrap layer](#6-pulumi-bootstrap-layer)
7. [Secrets via Infisical](#7-secrets-via-infisical)
8. [Argo CD app layer (GitOps)](#8-argo-cd-app-layer-gitops)
9. [NetworkPolicies](#9-networkpolicies)
10. [Resource sizing](#10-resource-sizing)
11. [Deploy & verify](#11-deploy--verify)
12. [Designing for growth](#12-designing-for-growth)
13. [What was wrong in the original draft](#13-what-was-wrong-in-the-original-draft)

---

## 1. Architecture

```
                         Internet
                            │
            ┌───────────────┼────────────────┐
            │ :80/:443 (public)               │ :51820/udp (WireGuard, public)
            ▼                                 ▼
        ┌────────┐                       ┌─────────┐
        │Traefik │  ◀── cert-manager     │WireGuard│  wg0: 10.10.0.1
        │(ingress)│      (Let's Encrypt)  │ (host)  │  ── admin only ──▶ :22 SSH, :6443 API
        └────┬───┘                       └─────────┘
             │ IngressRoute (Host rule, TLS)
             ▼
        ┌────────┐   DB creds (secretKeyRef)     ┌──────────────┐
        │ Go API │ ────────────────────────────▶ │ CNPG Postgres│ ──▶ Tigris (WAL + base backups)
        │ (2–3x) │   Valkey pw (Infisical)        │  prod-database│
        └───┬────┘ ────────────────────────────▶ ┌──────────────┐
            │                                     │ Valkey (AOF) │
            └─────────────────────────────────▶  └──────────────┘

Namespaces:  traefik · cert-manager · cnpg-system · valkey · api · argocd · infisical-operator
```

**Responsibility split**

| Layer | Owned by | Contents |
|---|---|---|
| Cluster bootstrap | **Pulumi** | namespaces, cert-manager, Traefik, CNPG **operator**, Argo CD, Infisical operator, `ClusterIssuer`s |
| App workloads | **Argo CD** (App-of-Apps from Git) | CNPG **`Cluster`** CR, Valkey StatefulSet, Go API Deployment/Service, `IngressRoute`, `Certificate`, `NetworkPolicy`, Infisical `InfisicalStaticSecret` CRDs |
| Secret values | **Infisical** | never in Git, never in Pulumi state |

Rule of thumb: **Pulumi installs the machinery; Argo CD runs the app.** No resource is defined in both.

---

## 2. Prerequisites

- A domain with a public DNS **A record** → your VPS public IP (needed for the HTTP-01 ACME challenge).
- **Tigris** account → a bucket (e.g. `pg-backups`) and an **Access Key ID / Secret Access Key**.
  - S3 endpoint: `https://fly.storage.tigris.dev` · region: `auto`.
- **Infisical** — a project and a **Machine Identity** (Universal Auth → Client ID + Client Secret).
  Cloud (`https://app.infisical.com`) or self-hosted; both work with the operator.
- Local tools: `pulumi`, `node`/`pnpm`, `kubectl`, `helm`, `wg` (wireguard-tools), `wg-quick`.
- Your VPS provider console access (for the initial public SSH before WireGuard is up).

---

## 3. Host hardening (before k3s)

> **Ordering matters.** You start with public SSH (that's how you got in). We harden SSH, add the
> firewall and fail2ban, bring up WireGuard, and **only then** restrict SSH/API to the WireGuard
> interface. Do not lock SSH to `wg0` before WireGuard works or you'll lock yourself out — use the
> provider's web console as a rescue path.

### 3.1 Non-root sudo user

```bash
# as root
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/    # reuse your key
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

Confirm you can `ssh deploy@<public-ip>` in a **second terminal** before continuing.

### 3.2 SSH: key-only, no root, no passwords

Edit `/etc/ssh/sshd_config` (or drop a file in `/etc/ssh/sshd_config.d/99-hardening.conf`):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
AllowUsers deploy
```

```bash
sudo sshd -t && sudo systemctl restart ssh   # 'ssh' or 'sshd' depending on distro
```

### 3.3 fail2ban (brute-force protection)

```bash
sudo apt-get update && sudo apt-get install -y fail2ban
sudo tee /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
port     = ssh
maxretry = 4
findtime = 10m
bantime  = 1h
EOF
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

### 3.4 Firewall (ufw)

Public: only WireGuard (51820/udp) and the web ports (80/443). SSH (22) and the k8s API (6443)
are restricted to the WireGuard subnet — applied fully in [§4](#4-wireguard-private-admin-plane).

```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 51820/udp comment 'WireGuard'
sudo ufw allow 80/tcp   comment 'HTTP (ACME + redirect)'
sudo ufw allow 443/tcp  comment 'HTTPS'
sudo ufw allow 22/tcp   comment 'SSH (TEMP public - tighten in §4)'
# CRITICAL: trust k3s internal CIDRs or Flannel pod/service/DNS traffic gets dropped
# (default 'deny incoming' otherwise breaks CoreDNS → CrashLoopBackOff). k3s defaults:
sudo ufw allow from 10.42.0.0/16 to any comment 'k3s Pods (Flannel CIDR)'
sudo ufw allow from 10.43.0.0/16 to any comment 'k3s Services (ClusterIP CIDR)'
sudo ufw enable
sudo ufw status verbose
```

> These two CIDRs are the k3s defaults. If you override `--cluster-cidr` / `--service-cidr` at
> install time, match them here.

### 3.5 Kernel tuning (`sysctl`)

The original draft's values are mostly fine; corrected and consolidated:

```bash
sudo tee /etc/sysctl.d/99-k3s-tuning.conf <<'EOF'
fs.file-max = 2097152
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 8192
vm.max_map_count = 262144
net.core.somaxconn = 32768
net.ipv4.tcp_tw_reuse = 1              # helps OUTBOUND reuse (API→DB, API→external), not inbound
net.ipv4.ip_local_port_range = 1024 65535
EOF
sudo sysctl --system
```

### 3.6 Container log rotation — do it in the kubelet, not logrotate

The draft used `logrotate` with `copytruncate` on `/var/log/pods`, which races with containerd and
can drop lines. Instead let the kubelet rotate (configured via k3s flags in [§5](#5-install-k3s)):
`container-log-max-size=50Mi`, `container-log-max-files=3`. **No `/etc/logrotate.d/k3s-*` file.**

### 3.7 Patching policy — manual, not automatic

Per decision, **no `unattended-upgrades`**. Patch on a controlled cadence:

```bash
# review, then apply during a maintenance window
sudo apt-get update && apt list --upgradable
sudo apt-get upgrade      # deliberate, reviewed
```

---

## 4. WireGuard (private admin plane)

Goal: the Kubernetes API (`6443`) and SSH (`22`) are reachable **only** over an encrypted WireGuard
tunnel on the same VPS. Nothing extra to host.

### 4.1 Server (VPS)

```bash
sudo apt-get install -y wireguard
wg genkey | sudo tee /etc/wireguard/server.key | wg pubkey | sudo tee /etc/wireguard/server.pub
sudo chmod 600 /etc/wireguard/server.key
```

`/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = <contents of /etc/wireguard/server.key>

# --- your laptop ---
[Peer]
PublicKey = <LAPTOP_PUBLIC_KEY>
AllowedIPs = 10.10.0.2/32
```

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show
```

### 4.2 Client (laptop)

```bash
wg genkey | tee laptop.key | wg pubkey > laptop.pub   # put laptop.pub into wg0.conf above
```

`~/wg-vps.conf`:

```ini
[Interface]
Address = 10.10.0.2/24
PrivateKey = <contents of laptop.key>

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>          # /etc/wireguard/server.pub
Endpoint = <VPS_PUBLIC_IP>:51820
AllowedIPs = 10.10.0.0/24                # only route the tunnel subnet
PersistentKeepalive = 25
```

```bash
sudo wg-quick up ~/wg-vps.conf
ping 10.10.0.1     # should succeed
```

### 4.3 Now lock SSH + API to the tunnel

```bash
# remove the temporary public SSH rule, allow SSH + API only from wg0 subnet
sudo ufw delete allow 22/tcp
sudo ufw allow from 10.10.0.0/24 to any port 22   proto tcp comment 'SSH via WireGuard'
sudo ufw allow from 10.10.0.0/24 to any port 6443 proto tcp comment 'k8s API via WireGuard'
sudo ufw status verbose
```

From now on you SSH to `deploy@10.10.0.1` (tunnel up first). Public 22 is closed.

---

## 5. Install k3s

```bash
# on the VPS (as deploy, via WireGuard SSH)
curl -sfL https://get.k3s.io | sudo sh -s - \
  --disable traefik \
  --secrets-encryption \
  --tls-san 10.10.0.1 \
  --write-kubeconfig-mode 600 \
  --kubelet-arg=container-log-max-size=50Mi \
  --kubelet-arg=container-log-max-files=3
```

- `--disable traefik` — we install a tuned Traefik via Pulumi.
- `--secrets-encryption` — encrypts Secrets at rest in the datastore.
- `--tls-san 10.10.0.1` — API cert valid for the **WireGuard** address (not the public IP).
- log-rotation flags replace the logrotate hack from §3.6.

Copy the kubeconfig to your laptop and point it at the WireGuard IP:

```bash
# on VPS
sudo cat /etc/rancher/k3s/k3s.yaml
# on laptop: save as ~/.kube/config-vps, then replace the server line:
#   server: https://127.0.0.1:6443   ->   server: https://10.10.0.1:6443
export KUBECONFIG=~/.kube/config-vps
kubectl get nodes           # Ready
```

> Never put the **public** IP in kubeconfig. The API is intentionally unreachable off-tunnel.

---

## 6. Pulumi bootstrap layer

Installs the cluster machinery only. **No application secrets** live here — the sole secret is the
Infisical machine-identity client secret the operator needs to authenticate.

```bash
mkdir infra && cd infra
pulumi new kubernetes-typescript --yes
npm install @pulumi/kubernetes @pulumi/pulumi
```

Config (encrypted where marked):

```bash
pulumi config set domain yourdomain.com
pulumi config set acmeEmail you@yourdomain.com
pulumi config set --secret infisicalClientId     <MACHINE_IDENTITY_CLIENT_ID>
pulumi config set --secret infisicalClientSecret <MACHINE_IDENTITY_CLIENT_SECRET>
```

`index.ts`:

```ts
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");            // e.g. yourdomain.com
const acmeEmail = cfg.require("acmeEmail");
const infisicalClientId = cfg.requireSecret("infisicalClientId");
const infisicalClientSecret = cfg.requireSecret("infisicalClientSecret");

// ── namespaces ────────────────────────────────────────────────────────────
const ns = (name: string) =>
  new k8s.core.v1.Namespace(name, { metadata: { name } });
const certManagerNs = ns("cert-manager");
const traefikNs      = ns("traefik");
const cnpgNs         = ns("cnpg-system");
const argocdNs       = ns("argocd");
const infisicalNs    = ns("infisical-operator");
// app + valkey namespaces are created by Argo CD's App-of-Apps

// ── cert-manager (correct repo; crds.enabled replaces installCRDs) ─────────
const certManager = new k8s.helm.v3.Release("cert-manager", {
  chart: "cert-manager",
  version: "v1.16.2",
  repositoryOpts: { repo: "https://charts.jetstack.io" },
  namespace: certManagerNs.metadata.name,
  values: { crds: { enabled: true } },
}, { dependsOn: certManagerNs });

// ── Traefik (correct repo; 2 replicas, dashboard off, global 80→443) ───────
const traefik = new k8s.helm.v3.Release("traefik", {
  chart: "traefik",
  version: "34.4.1",                       // pin; see `helm search repo traefik/traefik`
  repositoryOpts: { repo: "https://traefik.github.io/charts" },
  namespace: traefikNs.metadata.name,
  values: {
    deployment: { replicas: 2 },           // single node: HA-neutral, enables rolling updates
    resources: {
      requests: { cpu: "200m", memory: "128Mi" },
      limits:   { cpu: "500m", memory: "256Mi" },
    },
    ports: {
      web:       { redirectTo: { port: "websecure" } },  // global HTTP→HTTPS
      websecure: { tls: { enabled: true } },
    },
    ingressRoute: { dashboard: { enabled: false } },     // no public dashboard
    service: { type: "LoadBalancer" },                   // k3s servicelb binds 80/443 on host
  },
}, { dependsOn: [traefikNs] });

// ── CloudNativePG OPERATOR (the Cluster CR is managed by Argo CD later) ────
const cnpg = new k8s.helm.v3.Release("cloudnative-pg", {
  chart: "cloudnative-pg",
  version: "0.23.0",                       // pin; `helm search repo cnpg/cloudnative-pg`
  repositoryOpts: { repo: "https://cloudnative-pg.github.io/charts" },
  namespace: cnpgNs.metadata.name,
}, { dependsOn: cnpgNs });

// ── Argo CD ────────────────────────────────────────────────────────────────
const argocd = new k8s.helm.v3.Release("argocd", {
  chart: "argo-cd",
  version: "7.7.11",
  repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
  namespace: argocdNs.metadata.name,
}, { dependsOn: argocdNs });

// ── Infisical Kubernetes Operator ──────────────────────────────────────────
const infisical = new k8s.helm.v3.Release("infisical-operator", {
  chart: "secrets-operator",
  repositoryOpts: { repo: "https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/" },
  namespace: infisicalNs.metadata.name,
}, { dependsOn: infisicalNs });

// Bootstrap secret the operator uses to talk to Infisical (Universal Auth).
// This is the ONLY secret Pulumi holds; app secrets flow through Infisical.
const infisicalAuth = new k8s.core.v1.Secret("infisical-universal-auth", {
  metadata: { name: "infisical-universal-auth", namespace: infisicalNs.metadata.name },
  stringData: {
    clientId: infisicalClientId,
    clientSecret: infisicalClientSecret,
  },
}, { dependsOn: infisical });

// ── ClusterIssuers: Let's Encrypt STAGING + PRODUCTION (correct ACME URLs) ─
const issuer = (name: string, server: string) =>
  new k8s.apiextensions.CustomResource(name, {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: { name },
    spec: {
      acme: {
        server,
        email: acmeEmail,
        privateKeySecretRef: { name: `${name}-account-key` },
        solvers: [{ http01: { ingress: { ingressClassName: "traefik" } } }],
      },
    },
  }, { dependsOn: [certManager] });

// Test with staging first (avoids Let's Encrypt rate limits), then switch to production.
issuer("letsencrypt-staging",    "https://acme-staging-v02.api.letsencrypt.org/directory");
issuer("letsencrypt-production", "https://acme-v02.api.letsencrypt.org/directory");

export const infisicalAuthSecretName = infisicalAuth.metadata.name;
```

```bash
pulumi up
```

> Chart versions above are pinned examples — run `helm repo add ... && helm search repo <chart>`
> to confirm the current version before committing, and pin the exact one you tested.

---

## 7. Secrets via Infisical

The operator (v1beta1) syncs Infisical → native Kubernetes `Secret`s and **auto-redeploys pods when a
value rotates**. Only the value-free CRDs below live in Git.

Store these in your Infisical project (per environment, e.g. `prod`):

| Key | Consumed by |
|---|---|
| `VALKEY_PASSWORD` | Valkey StatefulSet + Go API |
| `SENTRY_DSN` | Go API |
| `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY` | CNPG backup credentials |

Example CRDs (committed to the app Git repo, managed by Argo CD):

```yaml
# infisical-connection.yaml
apiVersion: secrets.infisical.com/v1beta1
kind: InfisicalConnection
metadata: { name: infisical, namespace: api }
spec:
  hostAPI: https://app.infisical.com          # or your self-hosted URL
---
# infisical-auth.yaml — references the Pulumi-created universal-auth secret
apiVersion: secrets.infisical.com/v1beta1
kind: InfisicalAuth
metadata: { name: infisical-auth, namespace: api }
spec:
  connectionRef: { name: infisical }
  universalAuth:
    credentialsRef:
      secretName: infisical-universal-auth
      secretNamespace: infisical-operator
---
# api-secrets.yaml — syncs Infisical → k8s Secret "api-secrets"
apiVersion: secrets.infisical.com/v1beta1
kind: InfisicalStaticSecret
metadata: { name: api-secrets, namespace: api }
spec:
  authRef: { name: infisical-auth }
  projectId: <INFISICAL_PROJECT_ID>
  environment: prod
  secretsPath: /
  managedKubeSecretReferences:
    - secretName: api-secrets
      secretNamespace: api
      creationPolicy: Orphan
```

> CRD field names track the operator version — verify against the chart you installed
> (`kubectl explain infisicalstaticsecret.spec`). The model is stable: connection → auth →
> static-secret → managed k8s Secret.

Workloads then reference `api-secrets` via `secretKeyRef` / `envFrom` (see §8). **DB credentials are
the exception** — those come from CNPG's own generated secret, not Infisical (see below).

---

## 8. Argo CD app layer (GitOps)

Put the following manifests in a Git repo (e.g. `k8s-apps/`) and register an **App-of-Apps** so Argo CD
syncs them. Access the Argo CD UI over the tunnel:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8080:443   # visit https://localhost:8080
```

### 8.1 CNPG `Cluster` with Tigris backup

CNPG auto-creates the app database and a secret named **`prod-database-app`** holding
`username`/`password`/`dbname`/`host`/`port`. The Go API reads *that* secret for DB creds.

```yaml
# db-backup-creds.yaml — Tigris keys, synced from Infisical into cnpg-system
apiVersion: secrets.infisical.com/v1beta1
kind: InfisicalStaticSecret
metadata: { name: tigris-creds, namespace: cnpg-system }
spec:
  authRef: { name: infisical-auth }         # (an InfisicalAuth also present in cnpg-system)
  projectId: <INFISICAL_PROJECT_ID>
  environment: prod
  secretsPath: /
  managedKubeSecretReferences:
    - secretName: tigris-creds              # keys: TIGRIS_ACCESS_KEY_ID / TIGRIS_SECRET_ACCESS_KEY
      secretNamespace: cnpg-system
      creationPolicy: Orphan
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: prod-database, namespace: cnpg-system }
spec:
  instances: 1                              # single node; bump to 3 when you add nodes
  storage:
    size: 40Gi
    storageClass: local-path
  resources:
    requests: { cpu: "1",   memory: "1Gi" }
    limits:   { cpu: "2",   memory: "4Gi" }
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "1GB"
      effective_cache_size: "3GB"
      work_mem: "16MB"
  bootstrap:
    initdb:
      database: appdb
      owner: appuser
  backup:
    barmanObjectStore:
      destinationPath: "s3://pg-backups/prod-database"
      endpointURL: "https://fly.storage.tigris.dev"
      s3Credentials:
        accessKeyId:     { name: tigris-creds, key: TIGRIS_ACCESS_KEY_ID }
        secretAccessKey: { name: tigris-creds, key: TIGRIS_SECRET_ACCESS_KEY }
      wal:      { compression: gzip }
      data:     { compression: gzip }
    retentionPolicy: "14d"
---
# scheduled base backup (WAL is archived continuously by barmanObjectStore above)
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata: { name: prod-database-daily, namespace: cnpg-system }
spec:
  schedule: "0 0 3 * * *"                   # 03:00 daily (6-field CNPG cron)
  backupOwnerReference: self
  cluster: { name: prod-database }
```

This gives you **continuous WAL archiving + daily base backups + 14-day retention** off-node →
point-in-time recovery even if the VPS is lost.

### 8.2 Valkey — official image, StatefulSet

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: valkey-config, namespace: valkey }
data:
  valkey.conf: |
    appendonly yes
    appendfsync everysec
    maxmemory 1500mb
    maxmemory-policy allkeys-lru
    save 900 1
    save 300 10
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: valkey, namespace: valkey }
spec:
  serviceName: valkey
  replicas: 1
  selector: { matchLabels: { app: valkey } }
  template:
    metadata: { labels: { app: valkey } }
    spec:
      containers:
        - name: valkey
          image: valkey/valkey:8.1-alpine        # pin an immutable tag
          args: ["/etc/valkey/valkey.conf", "--requirepass", "$(VALKEY_PASSWORD)"]
          env:
            - name: VALKEY_PASSWORD
              valueFrom: { secretKeyRef: { name: api-secrets, key: VALKEY_PASSWORD } }
            # valkey-cli auto-reads VALKEYCLI_AUTH — keeps the probe shell-free and
            # safe even if the password contains quotes/special chars
            - name: VALKEYCLI_AUTH
              valueFrom: { secretKeyRef: { name: api-secrets, key: VALKEY_PASSWORD } }
          ports: [{ containerPort: 6379 }]
          volumeMounts:
            - { name: data,   mountPath: /data }
            - { name: config, mountPath: /etc/valkey }
          readinessProbe:
            exec: { command: ["valkey-cli", "ping"] }
            initialDelaySeconds: 5
          resources:
            requests: { cpu: "250m", memory: "512Mi" }
            limits:   { cpu: "1",    memory: "2Gi" }
      volumes:
        - name: config
          configMap: { name: valkey-config }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: local-path
        resources: { requests: { storage: 10Gi } }
---
apiVersion: v1
kind: Service
metadata: { name: valkey, namespace: valkey }
spec:
  clusterIP: None
  selector: { app: valkey }
  ports: [{ port: 6379, targetPort: 6379 }]
```

> A `valkey` namespace + its own `InfisicalStaticSecret` (syncing `VALKEY_PASSWORD` into `api-secrets`
> in the `valkey` namespace) are needed too — mirror the pattern from §7.

### 8.3 Go API

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: go-api, namespace: api }
spec:
  replicas: 2
  selector: { matchLabels: { app: go-api } }
  template:
    metadata: { labels: { app: go-api } }
    spec:
      containers:
        - name: api
          image: your-registry/go-api:v1.4.2      # pinned tag/digest — never :latest
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 8080 }]
          env:
            - name: GOMEMLIMIT
              value: "700MiB"                       # BELOW the 768Mi limit — leaves GC headroom
            # DB creds from CNPG's generated secret (NOT Infisical)
            - name: DB_HOST
              value: prod-database-rw.cnpg-system.svc.cluster.local
            - name: DB_USER
              valueFrom: { secretKeyRef: { name: prod-database-app, key: username } }
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: prod-database-app, key: password } }
            - name: DB_NAME
              valueFrom: { secretKeyRef: { name: prod-database-app, key: dbname } }
            # app secrets from Infisical-synced "api-secrets"
            - name: VALKEY_HOST
              value: valkey.valkey.svc.cluster.local
            - name: VALKEY_PORT
              value: "6379"
            - name: VALKEY_PASSWORD
              valueFrom: { secretKeyRef: { name: api-secrets, key: VALKEY_PASSWORD } }
            - name: SENTRY_DSN
              valueFrom: { secretKeyRef: { name: api-secrets, key: SENTRY_DSN } }
          resources:
            requests: { cpu: "100m", memory: "128Mi" }
            limits:   { cpu: "500m", memory: "768Mi" }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 10
            periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata: { name: go-api-svc, namespace: api }
spec:
  selector: { app: go-api }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: go-api-pdb, namespace: api }
spec:
  minAvailable: 1
  selector: { matchLabels: { app: go-api } }
```

### 8.4 TLS + routing (cert-manager `Certificate` + Traefik `IngressRoute`)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: api-tls-cert, namespace: api }
spec:
  secretName: api-tls-cert
  issuerRef: { name: letsencrypt-production, kind: ClusterIssuer }  # use -staging first
  dnsNames: ["yourdomain.com"]
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata: { name: api-server-tls, namespace: api }
spec:
  entryPoints: ["websecure"]
  routes:
    - match: "Host(`yourdomain.com`)"
      kind: Rule
      services:
        - { name: go-api-svc, port: 80 }
  tls: { secretName: api-tls-cert }
```

---

## 9. NetworkPolicies

k3s ships an embedded NetworkPolicy controller, so these are enforced out of the box. Default-deny per
namespace, then allow only what's needed. Example for `api` (replicate the pattern for others):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: api }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-allow, namespace: api }
spec:
  podSelector: { matchLabels: { app: go-api } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: traefik } } }]
      ports: [{ port: 8080 }]
  egress:
    # DNS
    - to: [{ namespaceSelector: {} }]
      ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
    # Postgres
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: cnpg-system } } }]
      ports: [{ port: 5432 }]
    # Valkey
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: valkey } } }]
      ports: [{ port: 6379 }]
```

> Namespaces get the `kubernetes.io/metadata.name` label automatically.
>
> **Egress scope — a common misconception:** the Go API does **not** talk to Infisical. The Infisical
> *operator* (in `infisical-operator`) is what reaches Infisical Cloud and syncs values into native
> k8s Secrets; the API just reads those injected env vars at startup. So:
> - `infisical-operator` namespace → needs egress to Infisical Cloud (`app.infisical.com` / your host).
> - `cnpg-system` → needs egress to Tigris (`fly.storage.tigris.dev`) for backups.
> - `api` (Go API) → only needs external egress for **Sentry** (plus cluster-internal DNS/PG/Valkey above).
>
> Add an allow-egress-to-external rule scoped per namespace accordingly (or route through an egress proxy).

---

## 10. Resource sizing

Tuned for the **16 GB / 6 vCPU** starter box, leaving ≥2 GB RAM and ≥1 vCPU for the OS + kubelet +
k3s control plane. Requests are what the scheduler reserves; limits cap bursts.

| Workload | Replicas | CPU req | CPU limit | Mem req | Mem limit |
|---|---|---|---|---|---|
| Traefik | 2 | 200m | 500m | 128Mi | 256Mi |
| CNPG Postgres | 1 | 1 | 2 | 1Gi | 4Gi |
| Valkey | 1 | 250m | 1 | 512Mi | 2Gi |
| Go API | 2 | 100m | 500m | 128Mi | 768Mi |
| **Sum (requests)** | | **~1.9 vCPU** | | **~2.9 GB** | |
| **Sum (limits)** | | ~4.5 vCPU | | ~8.6 GB | |

Requests fit comfortably; limits allow bursting without overcommitting RAM. **10 GB / 32 GB upgrade:**
raise Postgres to `2/4` CPU + `2Gi/8Gi` mem (`shared_buffers 2GB`, `effective_cache_size 6GB`), Valkey
`maxmemory` to ~3–4 GB, Go API to 3 replicas.

---

## 11. Deploy & verify

```bash
# 1. Bootstrap (laptop, tunnel up)
cd infra && pulumi up
# NOTE: on the FIRST run the ClusterIssuer may fail with a webhook connection error —
# cert-manager's webhook needs ~5–10s after install to generate its own TLS and become
# ready. This is harmless: just run `pulumi up` again and it will converge.

# 2. Point DNS A record → VPS public IP (before requesting the production cert)

# 3. Register the App-of-Apps in Argo CD, then watch it sync
kubectl -n argocd get applications
kubectl -n argocd port-forward svc/argocd-server 8080:443   # UI at https://localhost:8080

# 4. Certificate issued? (start with letsencrypt-staging, then switch to -production)
kubectl -n api get certificate api-tls-cert          # READY=True
kubectl -n api describe certificate api-tls-cert     # events on failure

# 5. End-to-end
curl -v https://yourdomain.com/healthz               # 200, valid cert

# 6. Database is up and backing up
kubectl -n cnpg-system get cluster prod-database     # STATUS=Cluster in healthy state
kubectl -n cnpg-system get backup                    # completed backups
kubectl -n cnpg-system get scheduledbackup

# 7. Secrets synced (values should be populated, not empty)
kubectl -n api get secret api-secrets -o jsonpath='{.data}' | jq 'keys'

# 8. NetworkPolicies enforced (this should TIME OUT / fail)
kubectl -n api run probe --rm -it --image=busybox --restart=Never -- \
  wget -T3 -qO- http://valkey.valkey.svc.cluster.local:6379   # blocked unless from go-api pod
```

**Failure drills** (do these once, so you trust the setup):
- Delete a Go API pod → PDB keeps 1 serving, replacement comes up healthy.
- `kubectl -n cnpg-system delete pod prod-database-1` → CNPG restarts it; data intact (local-path PVC).
- Practice a **restore** into a throwaway cluster from Tigris to prove backups are real.

---

## 12. Designing for growth

When you add a second node, flip these — no re-architecture needed:

- **Postgres HA:** `spec.instances: 3` on the CNPG `Cluster` (needs multi-node + a replicated or
  networked storage class; `local-path` pins a pod to one node).
- **Storage:** replace `local-path` with a replicated CSI (e.g. Longhorn) so PVCs survive node loss.
- **Traefik:** raise replicas and add pod anti-affinity so they land on different nodes.
- **Go API:** add pod anti-affinity + an HPA (`autoscaling/v2` on CPU or custom metrics).
- **k3s:** join the new node as an agent (or a second server for control-plane HA — needs an
  external datastore or embedded etcd with 3 servers).
- **WireGuard:** add each admin peer; consider a mesh for node-to-node if not on a private network.

---

## 13. What was wrong in the original draft

For the record — these are corrected throughout this runbook:

| Area | Draft | Fix here |
|---|---|---|
| ACME server | `https://letsencrypt.org` | `https://acme-v02.api.letsencrypt.org/directory` (+ staging first) |
| Traefik repo | `https://github.io` | `https://traefik.github.io/charts` |
| CNPG repo | `https://github.io` | `https://cloudnative-pg.github.io/charts` |
| cert-manager repo | `https://jetstack.io` | `https://charts.jetstack.io` (`crds.enabled`) |
| Valkey | invalid repo + Bitnami chart | official `valkey/valkey` image, self-managed StatefulSet |
| `domain` | `"://yourdomain.com"` | plain `yourdomain.com` |
| `GOMEMLIMIT` | `4GiB` in a `1Gi` pod (instant OOMKill) | `700MiB` under a `768Mi` limit |
| Secrets | plaintext `value:` in Deployment | Infisical → `secretKeyRef`; k3s `--secrets-encryption` |
| DB credentials | never wired (only `DB_HOST`) | from CNPG's generated `prod-database-app` secret |
| Backups | none (`instances:1`, `local-path`) | continuous WAL + daily base backup to Tigris, 14d retention |
| API exposure | public 6443 in kubeconfig | private behind WireGuard; firewall blocks 6443 |
| Host | no firewall / SSH / fail2ban | ufw + key-only SSH + fail2ban |
| Probes / PDB / image | none / `:latest` | liveness+readiness, PDB, pinned image tag |
| Traefik replicas | 3 on one node | 2 (rolling updates; scale with nodes) |
| Resource totals | ~18Gi limits on a 16 GB box | sized to fit with OS headroom |
| Log rotation | logrotate + copytruncate | kubelet `container-log-max-*` flags |
```
