# PayFlow — Invoice & Billing SaaS on DOKS

A containerized Node.js invoicing application deployed on **DigitalOcean Kubernetes (DOKS)** with load balancing, horizontal pod autoscaling, and cost-optimized infrastructure.

## Architecture Overview

```
Internet → DO Load Balancer → NGINX Ingress Controller → PayFlow Pods (2-10)
                                                              ↑
                                                     HPA (CPU > 70%)
```

**Stack:** Node.js 18 + Express · Docker · Kubernetes · NGINX Ingress · DO Load Balancer · HPA

---

## Prerequisites

- [DigitalOcean account](https://cloud.digitalocean.com) with credits
- [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) CLI installed and authenticated
- [kubectl](https://kubernetes.io/docs/tasks/tools/) installed
- [Docker](https://docs.docker.com/get-docker/) installed
- [Helm](https://helm.sh/docs/intro/install/) installed

---

## Step-by-Step Deployment Guide

### 1. Create a DOKS Cluster

```bash
doctl kubernetes cluster create payflow-cluster \
  --region nyc1 \
  --node-pool "name=worker-pool;size=s-2vcpu-4gb;count=2;auto-scale=true;min-nodes=2;max-nodes=4" \
  --version latest
```

Wait ~4 minutes for provisioning. Then configure kubectl:

```bash
doctl kubernetes cluster kubeconfig save payflow-cluster
kubectl get nodes  # Verify 2 nodes are Ready
```

### 2. Set Up DO Container Registry

```bash
doctl registry create payflow-registry --region nyc1
doctl registry login

# Integrate registry with your DOKS cluster
doctl kubernetes cluster registry add payflow-cluster
```

### 3. Build & Push the Docker Image

```bash
cd app/

docker build -t registry.digitalocean.com/payflow-registry/payflow:latest .
docker push registry.digitalocean.com/payflow-registry/payflow:latest
```

### 4. Update Deployment Image Reference

Edit `k8s/deployment.yaml` and replace `<your-registry>` with your actual registry name:

```yaml
image: registry.digitalocean.com/payflow-registry/payflow:latest
```

### 5. Install NGINX Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install nginx-ingress ingress-nginx/ingress-nginx \
  --set controller.publishService.enabled=true
```

This auto-provisions a **DigitalOcean Load Balancer** (~$12/mo).

### 6. Install Metrics Server (Required for HPA)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Verify:
```bash
kubectl top nodes  # Should show CPU/memory after ~60s
```

### 7. Deploy the Application

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml
```

Verify everything is running:
```bash
kubectl get pods                    # 2 PayFlow pods running
kubectl get svc                     # ClusterIP service active
kubectl get ingress                 # Ingress with external IP
kubectl get hpa                     # HPA targets showing
```

### 8. Get Your External IP

```bash
kubectl get svc nginx-ingress-ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Visit `http://<EXTERNAL-IP>` — you should see the PayFlow dashboard!

### 9. Verify Load Balancing

Open two terminals and run:

```bash
# Terminal 1: Watch pods
kubectl get pods -w

# Terminal 2: Hit health endpoint repeatedly — pod name changes
for i in $(seq 1 10); do curl -s http://<EXTERNAL-IP>/health | jq .pod; done
```

You'll see different pod hostnames, proving traffic distribution.

### 10. Trigger Autoscaling (HPA Demo)

Generate CPU load to trigger pod scaling:

```bash
# Install hey (HTTP load generator)
# macOS: brew install hey
# Linux: go install github.com/rakyll/hey@latest

# Blast the CPU-intensive endpoint
hey -z 120s -c 50 http://<EXTERNAL-IP>/generate-report

# In another terminal, watch HPA respond:
kubectl get hpa -w
kubectl get pods -w  # Watch new pods appear
```

CPU will spike above 70%, HPA will scale from 2 → 4+ pods, then scale back down after load stops.

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Invoice dashboard (HTML) |
| `/health` | GET | Health check with pod identity |
| `/invoices` | GET | List all invoices (JSON) |
| `/invoices` | POST | Create invoice `{client, amount, due}` |
| `/metrics` | GET | Prometheus-style metrics |
| `/generate-report` | GET | CPU-intensive report (for HPA demo) |

---

## Cost Analysis

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| DOKS Cluster (control plane) | Managed | $0 (free) |
| Worker Nodes (2× s-2vcpu-4gb) | 2 vCPU, 4GB each | $24/node = $48 |
| DO Load Balancer | Standard | $12 |
| Container Registry | Starter | $0 (free tier) |
| **Total baseline** | | **~$60/mo** |
| Node autoscaling (peak) | Up to 4 nodes | ~$96 (nodes only) |

**Cost optimization strategies:**
- Node autoscaling ensures you only pay for capacity during traffic spikes
- HPA scales pods within existing nodes before triggering node scaling
- Right-sized resource requests (100m CPU, 128Mi) prevent over-provisioning
- Single Load Balancer serves all ingress traffic (vs. one LB per service)

---

## Cleanup

```bash
kubectl delete -f k8s/
helm uninstall nginx-ingress
doctl kubernetes cluster delete payflow-cluster --force
doctl registry delete payflow-registry --force
```

---

## License

MIT — Built for DigitalOcean Sr. TAM interview assessment.
