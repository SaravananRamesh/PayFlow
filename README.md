# PayFlow — Invoice & Billing SaaS on DOKS

A containerized Node.js invoicing application deployed on **DigitalOcean Kubernetes (DOKS)** with PostgreSQL, load balancing, horizontal pod autoscaling, pod anti-affinity for high availability, and admin-protected write operations via Kubernetes Secrets.

## Architecture Overview

```
Internet → DO Load Balancer → NGINX Ingress → PayFlow Pods (2–10, spread across nodes)
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
payflow-saas/
├── app/
│   ├── server.js          # Express app with invoice API and /metrics endpoint
│   ├── Dockerfile         
│   └── package.json       
├── k8s/
│   ├── deployment.yaml    # PayFlow app deployment with pod anti-affinity
│   ├── service.yaml       # ClusterIP service
│   ├── ingress.yaml       # NGINX ingress (ingressClassName: nginx)
│   ├── hpa.yaml           # Horizontal Pod Autoscaler
│   ├── postgres.yaml      # PostgreSQL deployment + ClusterIP service
│   ├── pvc.yaml           # PersistentVolumeClaim for PostgreSQL
│   ├── configmap.yaml     # Non-sensitive config (PORT, DB_HOST, DB_NAME, DB_USER)
│   └── secret.yaml        # Kubernetes Secret template (ADMIN_PASSWORD, DB_PASSWORD)
└── README.md
```

---

## Step-by-Step Deployment Guide

### 1. Create a DOKS Cluster

```bash
doctl kubernetes cluster create payflow-cluster \
  --region nyc1 \
  --node-pool "name=worker-pool;size=s-1vcpu-2gb;count=2;auto-scale=true;min-nodes=2;max-nodes=3" \
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

# Generate and apply the registry secret to your cluster
doctl registry kubernetes-manifest | kubectl apply -f -

# Link the registry to your cluster so nodes can pull images
doctl kubernetes cluster registry add payflow-cluster
```


### 3. Build & Push the Docker Image

> **Apple Silicon Mac users:** DOKS nodes run `linux/amd64` — always specify the platform flag.

```bash
cd app/
npm install
docker build --platform linux/amd64 \
  -t registry.digitalocean.com/payflow-registry/payflow:latest .
docker push registry.digitalocean.com/payflow-registry/payflow:latest
```

### 4. Install NGINX Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install nginx-ingress ingress-nginx/ingress-nginx \
  --set controller.publishService.enabled=true
```

Wait ~60 seconds for the DO Load Balancer to provision an external IP:

```bash
kubectl get svc nginx-ingress-ingress-nginx-controller -w
# Wait until EXTERNAL-IP is assigned (not <pending>)
```

### 5. Install Metrics Server (Required for HPA)

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server \
--namespace metrics-server --create-namespace
```

Verify after ~60 seconds:

```bash
kubectl top nodes
```

### 6. Create Kubernetes Secret

Never commit real credentials to Git. Create the secret directly via kubectl:

```bash
kubectl create secret generic payflow-secrets \
  --from-literal=ADMIN_PASSWORD=yourchosenpassword \
  --from-literal=DB_PASSWORD=yourdbpassword \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 7. Deploy PostgreSQL

```bash
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/postgres.yaml

# Wait until postgres pod is Running before continuing
kubectl get pods -w
```

### 8. Deploy the Application

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml
```

Verify everything is running:

```bash
kubectl get pods -o wide   # 2 PayFlow pods + 1 postgres pod, on separate nodes
kubectl get svc            # ClusterIP services
kubectl get ingress        # Ingress with external IP
kubectl get hpa            # HPA targets showing CPU %
```

### 9. Get Your External IP

```bash
kubectl get svc nginx-ingress-ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Visit `http://<EXTERNAL-IP>` — you should see the PayFlow dashboard.

---

## Using the Dashboard

The dashboard is **read-only by default**. To add, update, or delete invoices:

1. Click the **🔒 locked** badge on the New Invoice form
2. Enter the `ADMIN_PASSWORD` you configured in Step 6
3. The form unlocks — you can now add invoices, mark them as paid, or delete them
4. Click **🔓 admin mode** to lock back

---

## API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | Public | Invoice dashboard (HTML) |
| `/health` | GET | Public | Health check with pod identity and DB status |
| `/invoices` | GET | Public | List all invoices (JSON) |
| `/invoices` | POST | Admin | Create invoice `{client, amount, due}` |
| `/invoices/:id` | PATCH | Admin | Update invoice status |
| `/invoices/:id` | DELETE | Admin | Delete invoice |
| `/metrics` | GET | Public | Prometheus-formatted metrics |
| `/generate-report` | GET | Public | CPU-intensive endpoint (for HPA demo) |

---

## Verify High Availability & Pod Anti-Affinity

```bash
# Confirm app pods are on different nodes
kubectl get pods -o wide
# The NODE column should show different node names for each payflow-app pod
```

---

## Verify Load Balancing

```bash
# Hit health endpoint repeatedly — pod hostname rotates between requests
for i in $(seq 1 10); do
  curl -s http://<EXTERNAL-IP>/health | jq .pod
done
```

---

## Trigger HPA Autoscaling

```bash
# Install hey: brew install hey  (macOS)
hey -z 120s -c 50 http://<EXTERNAL-IP>/generate-report

# Watch in separate terminals:
kubectl get hpa -w
kubectl get pods -w
kubectl get nodes -w
```

CPU spikes above 70% → HPA scales pods → required pod anti-affinity triggers cluster autoscaler to provision a new node. After load drops, pods and nodes scale back down.

---

## Scale Down (Save Costs When Not In Use)

```bash
kubectl scale deployment payflow-app --replicas=0
kubectl scale deployment postgres --replicas=0

doctl kubernetes cluster node-pool update payflow-cluster worker-pool \
  --min-nodes 1 --max-nodes 4 --count 1
```

---

## Cost Analysis

| Resource | Spec | Monthly Cost |
|---|---|---|
| DOKS Cluster (control plane) | Managed, NYC1 | $0 (free) |
| Worker Nodes (2× s-1vcpu-2gb) | 1 vCPU, 2GB each | $12/node = $24 |
| DO Load Balancer | Standard, Layer 4 | $12 |
| Container Registry | Starter tier | $0 (free) |
| PVC (PostgreSQL data) | 1Gi Block Storage | ~$0.10 |
| **Total baseline** | | **~$36/mo** |
| Node autoscaling peak (4 nodes) | s-1vcpu-2gb × 4 | ~$48 (nodes only) |

> vs AWS EKS equivalent: ~$159/mo — DOKS is 4× cheaper for the same architecture.

---

## Future Development

See [Future Development Roadmap](#) for planned enhancements including managed PostgreSQL, AI-powered invoice insights, observability with Prometheus/Grafana, and CI/CD pipeline automation.

---

## Cleanup

```bash
kubectl delete -f k8s/deployment.yaml
kubectl delete -f k8s/service.yaml
kubectl delete -f k8s/ingress.yaml
kubectl delete -f k8s/hpa.yaml
kubectl delete -f k8s/postgres.yaml
kubectl delete -f k8s/pvc.yaml
kubectl delete -f k8s/configmap.yaml
helm uninstall nginx-ingress
doctl kubernetes cluster delete payflow-cluster --force
doctl registry delete payflow-registry --force
```
