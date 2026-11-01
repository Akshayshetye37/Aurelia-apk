# Aurelia payment backend — Cloud Run infrastructure

This Terraform configuration creates the Cloud Run service and its restricted runtime identity. It is designed for an **external HTTPS Application Load Balancer with a serverless NEG** in front of Cloud Run.

## Security properties

- Cloud Run ingress is `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`.
- The default `run.app` URL is disabled.
- The service accepts traffic through the Google Cloud load-balancer path, not direct public Cloud Run ingress.
- Runtime identity is a dedicated service account, not the project default service account.
- Firestore access uses `roles/datastore.user`.
- Secret Manager access uses a custom role containing only the create/get/add-version/access-version permissions currently used by the backend.
- HTTPS proxy contract is configured explicitly: `AURELIA_HTTPS_TERMINATION=trusted-proxy` and `AURELIA_TRUST_PROXY_HOPS=1`.
- Container image must be pinned by sha256 digest; mutable `latest` tags are rejected.

## Prerequisites

1. A Google Cloud project with billing enabled.
2. Terraform 1.6+ and Google provider 6.x.
3. An immutable image already pushed to Artifact Registry.
4. Firestore Native mode initialized in the selected project and region.
5. A Google Cloud external Application Load Balancer, serverless NEG, HTTPS frontend, certificate and DNS record configured to target this Cloud Run service.
6. A review of the exact owner origins and IAM requirements for the deployed app.

This module intentionally does not create the external load balancer, DNS zone, certificate or serverless NEG: the production hostname and certificate ownership were not supplied. Do not expose the Cloud Run service through an alternate public endpoint.

## Apply

Create a local `terraform.tfvars` (never commit it):

```hcl
project_id      = "YOUR_GCP_PROJECT_ID"
region          = "asia-south1"
container_image = "asia-south1-docker.pkg.dev/YOUR_GCP_PROJECT_ID/YOUR_REPOSITORY/aurelia-payment-backend@sha256:REPLACE_WITH_64_HEX_DIGEST"
owner_origins   = "https://YOUR_PMS_HOSTNAME"
```

Then:

```sh
terraform init
terraform validate
terraform plan
terraform apply
```

The external HTTPS load balancer must be configured to use a serverless NEG referencing this Cloud Run service and must be the only public ingress route. Cloud Run IAM grants invocation to the load-balancer path; application-level admin endpoints still require Firebase ID token, verified email, MFA and active tenant-admin membership.

## Important operational caveats

- Do not run `terraform apply` until the project, immutable image, hostname, load balancer and certificate are ready.
- The first Terraform apply creates the service but does not create a usable public HTTPS endpoint by itself.
- Cloud Run ingress restriction is a control-plane setting; validate it after apply and perform an external bypass probe against the default service URL and any known service IPs.
- Terraform state contains infrastructure metadata. Store it in a protected remote backend with locking and encryption; do not commit state or tfvars.
- Review the custom Secret Manager role against any future backend code changes. If code starts using additional Secret Manager APIs, update IAM deliberately rather than granting project Owner/Editor.
- This deployment does not make the payment backend production-ready. The documented folio settlement, reconciliation and PMS integration blockers remain.
