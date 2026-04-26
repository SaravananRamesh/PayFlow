# PayFlow — Invoice & Billing SaaS on DOKS

A containerized Node.js invoicing application deployed on **DigitalOcean Kubernetes (DOKS)** with PostgreSQL, load balancing, horizontal pod autoscaling, pod anti-affinity for high availability, and admin-protected write operations via Kubernetes Secrets.

## Architecture Overview

```
Internet → DO Load Balancer → NGINX Ingress → PayFlow Pods (2-10, spread across nodes)
                                                      ↓
                                               PostgreSQL Pod
                                                      ↓
                                               PVC (DO Block Storage)
```

**Stack:** Node.js 18 + Express · PostgreSQL 15 · Docker · Kubernetes · NGINX Ingress · DO Load Balancer · HPA · Pod AntiAffinity

---

## Prerequisites

- [DigitalOcean account](https://cloud.digitalocean.com) with credits
- [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) CLI installed and authenticated
- [kubectl](https://kubernetes.io/docs/tasks/tools/) installed
- [Docker](https://docs.docker.com/get-docker/) installed
- [Helm](https://helm.sh/docs/intro/install/) installed
- [Node.js 18+](https://nodejs.org/) installed

---

## Project Structure

```
.
├── Dockerfile
├── server.js
├── package.json
├── package-lock.json
├── .dockerignore
├── deployment.yaml       # PayFlow app deployment with pod anti-affinity
├── service.yaml          # ClusterIP service
├── ingress.yaml          # NGINX ingress
├── hpa.yaml              # Horizontal Pod Autoscaler
├── postgres.yaml         # PostgreSQL deployment + ClusterIP service
├── pvc.yaml              # PersistentVolumeClaim for PostgreSQL
└── secret.yaml           # Kubernetes Secret (admin + DB passwords)
```

---

## Step-by-Step Deployment Guide

### 1. Create a DOKS Cluster

```bash
doctl kubernetes cluster create payflow-cluster \
  --region nyc1 \
  --node-pool "name=worker-pool;size=s-2vcpu-4gb;count=2;auto-scale=true;min-nodes=2;max-nodes=4" \
  --version latest
```

Wait ~4 minutes for provisioning, then configure kubectl:

```bash
doctl kubernetes cluster kubeconfig save payflow-cluster
kubectl get nodes  # Verify 2 nodes are Ready
```

### 2. Set Up DO Container Registry

```bash
doctl registry create payflow-registry --region nyc3
doctl registry login
doctl registry kubernetes-manifest | kubectl apply -f -
doctl kubernetes cluster registry add payflow-cluster
```

### 3. Build & Push the Docker Image

> **Apple Silicon Mac users:** DOKS nodes run `linux/amd64` — always specify the platform flag.

```bash
npm install
docker build --platform linux/amd64 -t registry.digitalocean.com/payflow-registry/payflow:latest .
docker push registry.digitalocean.com/payflow-registry/payflow:latest
```

### 4. Update the Deployment Image Reference

Edit `deployment.yaml` and replace `<your-registry>` with `payflow-registry` if not already set:

```yaml
image: registry.digitalocean.com/payflow-registry/payflow:latest
```

### 5. Create Secrets

Edit `secret.yaml` and set your passwords, then apply using kubectl to avoid committing real credentials:

```bash
kubectl create secret generic payflow-secrets \
  --from-literal=ADMIN_PASSWORD=yourchosenpassword \
  --from-literal=DB_PASSWORD=yourdbpassword \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 6. Deploy PostgreSQL

```bash
kubectl apply -f pvc.yaml
kubectl apply -f postgres.yaml

# Wait until postgres pod is Running before continuing
kubectl get pods -w
```

### 7. Install NGINX Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install nginx-ingress ingress-nginx/ingress-nginx \
  --set controller.publishService.enabled=true
```

### 8. Install Metrics Server (Required for HPA)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Verify after ~60 seconds:

```bash
kubectl top nodes
```

### 9. Deploy the Application

```bash
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml
kubectl apply -f hpa.yaml
```

Verify everything is running:

```bash
kubectl get pods       # 2 PayFlow pods + 1 postgres pod
kubectl get svc        # ClusterIP services
kubectl get ingress    # Ingress with external IP
kubectl get hpa        # HPA targets
```

### 10. Get Your External IP

```bash
kubectl get svc nginx-ingress-ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Visit `http://<EXTERNAL-IP>` — you should see the PayFlow dashboard.

---

## Using the Dashboard

The dashboard is **read-only by default**. To add, update, or delete invoices:

1. Click the **🔒 locked** badge on the New Invoice form
2. Enter the `ADMIN_PASSWORD` you configured in Step 5
3. The form unlocks — you can now add invoices, mark them as paid, or delete them
4. Click **🔓 admin mode** to lock back

---

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | Public | Invoice dashboard (HTML) |
| `/health` | GET | Public | Health check with pod identity and DB status |
| `/invoices` | GET | Public | List all invoices (JSON) |
| `/invoices` | POST | Admin | Create invoice `{client, amount, due}` |
| `/invoices/:id` | PATCH | Admin | Update invoice status |
| `/invoices/:id` | DELETE | Admin | Delete invoice |
| `/metrics` | GET | Public | Prometheus-style metrics |
| `/generate-report` | GET | Public | CPU-intensive report (for HPA demo) |

---

## Verify High Availability & Pod Anti-Affinity

```bash
# Confirm pods are on different nodes
kubectl get pods -o wide

# The NODE column should show different node names for each payflow-app pod
```

---

## Verify Load Balancing

```bash
# Hit health endpoint repeatedly — pod hostname changes between requests
for i in $(seq 1 10); do curl -s http://<EXTERNAL-IP>/health | jq .pod; done
```

---

## Trigger HPA Autoscaling

```bash
# Install hey (macOS: brew install hey)
hey -z 120s -c 50 http://<EXTERNAL-IP>/generate-report

# Watch in separate terminals
kubectl get hpa -w
kubectl get pods -w
```

CPU will spike above 70%, HPA scales from 2 → up to 10 pods, then back down after load stops.

---

## Cost Analysis

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| DOKS Cluster (control plane) | Managed | $0 (free) |
| Worker Nodes (2× s-2vcpu-4gb) | 2 vCPU, 4GB each | $24/node = $48 |
| DO Load Balancer | Standard | $12 |
| Container Registry | Starter | $0 (free tier) |
| PVC (PostgreSQL data) | 1Gi Block Storage | ~$0.10 |
| **Total baseline** | | **~$60/mo** |
| Node autoscaling (peak) | Up to 4 nodes | ~$96 (nodes only) |

---

## Future Development

See [Future Development Roadmap](#) for planned enhancements including managed PostgreSQL, AI-powered invoice insights, observability with Prometheus/Grafana, and CI/CD pipeline automation.

---

## Cleanup

```bash
kubectl delete -f deployment.yaml
kubectl delete -f service.yaml
kubectl delete -f ingress.yaml
kubectl delete -f hpa.yaml
kubectl delete -f postgres.yaml
kubectl delete -f pvc.yaml
helm uninstall nginx-ingress
doctl kubernetes cluster delete payflow-cluster --force
doctl registry delete payflow-registry --force
``
