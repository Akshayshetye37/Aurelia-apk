# Aurelia payment backend — Cloud Run infrastructure

This Terraform configuration creates the Cloud Run service and its restricted runtime identity. It is designed for an **external HTTPS Application Load Balancer with a serverless NEG** in front of Cloud Run.

## Security properties

- Cloud Run ingress is `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`.
- The default `run.app` URL is disabled.
- The service accepts traffic through the Google Cloud load-balancer path, not direct public Cloud Run ingress.
- Runtime identity is a dedicated service account, not the project default service account.
- Firestore access uses `roles/datastore.user`.
- Secret Manager access uses a custom role limited to secret create/get, version add/access/list and version disable; the runtime cannot delete secret resources or destroy credential history.
- HTTPS is the only public load-balancer listener (TCP/443); no TCP/80 listener, HTTP proxy or redirect is provisioned. The managed certificate and `MODERN` SSL policy enforce TLS 1.2 or newer at the public edge.
- The URL map adds `Strict-Transport-Security: max-age=63072000` to responses so browsers that have visited the HTTPS origin retain an HTTPS-only policy for two years.
- The backend service is configured with `protocol = "HTTPS"` as requested. Google ignores this field for Cloud Run serverless NEG backends, so it is not the mechanism that enables backend TLS. Cloud Run documentation states that HTTPS load-balancer traffic is forwarded to Cloud Run and the container through a Google-managed encrypted channel. The application container does not need to terminate TLS itself.
- Cloud Run ingress is restricted to internal and Cloud Load Balancing traffic, and its default `run.app` URL is disabled, preventing direct public ingress from bypassing the load balancer.
- HTTPS proxy contract is configured explicitly: `AURELIA_HTTPS_TERMINATION=trusted-proxy` and `AURELIA_TRUST_PROXY_HOPS=1`.
- Cloud Run manages instance readiness; this configuration uses supported startup and liveness probes. It does not declare a Terraform `readiness_probe` block, which the Google Cloud Run v2 provider does not support.
- Container image must be pinned by sha256 digest; mutable `latest` tags are rejected.

## Prerequisites

1. A Google Cloud project with billing enabled.
2. Terraform 1.6+ and Google provider 6.x.
3. An Artifact Registry repository and immutable container image already pushed to it.
4. Firestore Native mode initialized in the selected project and region.
5. A registered production domain and control of its DNS zone. This module creates a global external Application Load Balancer, serverless NEG, managed certificate, HTTPS-only frontend on TCP/443 and Cloud Armor rate-limit policy. No TCP/80 forwarding rule, HTTP proxy or redirect listener is created. DNS must point the domain to the `load_balancer_ip` output; certificate provisioning waits for DNS to resolve correctly.
6. A review of the exact owner origins and IAM requirements for the deployed app.

This module creates the external load balancer, managed certificate and serverless NEG, but does not create or change DNS records because DNS-zone ownership was not supplied. Do not expose the Cloud Run service through an alternate public endpoint.

## Apply

Create a local `terraform.tfvars` (never commit it):

```hcl
project_id      = "YOUR_GCP_PROJECT_ID"
region          = "asia-south1"
container_image = "asia-south1-docker.pkg.dev/YOUR_GCP_PROJECT_ID/YOUR_REPOSITORY/aurelia-payment-backend@sha256:REPLACE_WITH_64_HEX_DIGEST"
owner_origins   = "https://YOUR_PMS_HOSTNAME"
domain_name     = "YOUR_PAYMENT_API_HOSTNAME"
```

Then:

```sh
terraform init
terraform validate
terraform plan
terraform apply
```

Terraform creates the external HTTPS-only load balancer and serverless NEG. The public load balancer has no TCP/80 listener; clients must connect using `https://`. For this Cloud Run serverless NEG, Google ignores the backend `protocol` field; Cloud Run nevertheless documents that HTTPS load-balancer requests are forwarded to the container over a Google-managed encrypted channel. After apply, create the DNS A record for the domain using the `load_balancer_ip` output and wait for the managed certificate to become ACTIVE. Cloud Run IAM grants invocation to the load-balancer path; application-level admin endpoints still require Firebase ID token, verified email, MFA and active tenant-admin membership.

## Important operational caveats

- Do not run `terraform apply` until the project, immutable image, hostname, load balancer and certificate are ready.
- The first Terraform apply creates the HTTPS frontend, but it is not usable until DNS resolves to the load-balancer IP and the managed certificate becomes ACTIVE.
- Do not interpret `protocol = "HTTPS"` on the serverless NEG backend as an independently configurable TLS handshake. Google ignores that field for serverless NEGs. Encryption between the Google load balancer and Cloud Run is provided by the Cloud Run platform for HTTPS requests.
- Cloud Run ingress restriction is a control-plane setting; validate it after apply and perform an external bypass probe against the default service URL and any known service IPs.
- Terraform state contains infrastructure metadata. Store it in a protected remote backend with locking and encryption; do not commit state or tfvars.
- Cloud Run readiness is managed by the platform; the `/readyz` endpoint remains available for external monitoring and deployment verification, not as a Terraform readiness probe.
- Review the custom Secret Manager role against any future backend code changes. If code starts using additional Secret Manager APIs, update IAM deliberately rather than granting project Owner/Editor.
- This deployment does not make the payment backend production-ready. The documented folio settlement, reconciliation and PMS integration blockers remain.


## Production CD is intentionally not enabled yet

Do not copy a direct `gcloud run deploy` workflow into this repository. The
actual deployment contract is this Terraform module:

- Build from `payment-backend/Dockerfile.cloud`, not the attestation/LAN
  `Dockerfile`.
- Publish to the actual Artifact Registry repository, then pass the immutable
  `image@sha256:<digest>` to Terraform. The `container_image` variable rejects
  mutable tags.
- Deploy the existing service name/region from Terraform variables. The
  service disables its default `run.app` URL and accepts traffic through the
  external HTTPS load balancer only.
- Verify `https://<domain_name>/readyz` through the configured load balancer.
  The service's readiness path is `/readyz`; accepting HTTP 401 is not a
  readiness check.
- Preserve Cloud Run traffic and Terraform state deliberately. Listing
  revisions is not a rollback; a rollback must restore the previously captured
  healthy revision/traffic allocation and verify it.

A production workflow is not committed because this Terraform configuration
currently has no remote backend block or state bucket/locking contract, and
the repository has not supplied the real production project ID, Artifact
Registry repository, DNS hostname, Workload Identity Federation provider,
deployer service account, or GitHub production Environment approval rules.
The example identifiers in an unconfigured workflow would be placeholders,
not deployable infrastructure. Creating a CI job that runs `terraform apply`
with ephemeral local state would risk infrastructure drift and destructive
reconciliation. Configure and review remote state, WIF/IAM, Artifact Registry,
DNS/managed certificate and protected Environment approval before enabling
CD. Until then, CI may build and validate; production deployment remains
manual and unauthorized.
