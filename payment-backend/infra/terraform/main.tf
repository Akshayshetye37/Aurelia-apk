locals {
  required_apis = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com"
  ])
}

resource "google_project_service" "required" {
  for_each           = local.required_apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.service_name}-runtime"
  display_name = "Aurelia payment backend runtime"
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# The backend creates tenant-scoped secrets dynamically. This custom role grants
# only the Secret Manager operations used by the current server implementation.
resource "google_project_iam_custom_role" "payment_secret_runtime" {
  project     = var.project_id
  role_id     = "aureliaPaymentSecretRuntime"
  title       = "Aurelia payment secret runtime"
  description = "Create, write and read payment-provider secrets used by Aurelia."
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.get",
    "secretmanager.versions.add",
    "secretmanager.versions.access"
  ]
  stage = "GA"
}

resource "google_project_iam_member" "secret_runtime" {
  project = var.project_id
  role    = google_project_iam_custom_role.payment_secret_runtime.name
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "payment_backend" {
  project              = var.project_id
  name                 = var.service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  default_uri_disabled = true
  deletion_protection  = true

  template {
    service_account = google_service_account.runtime.email
    timeout         = "60s"

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instance_count
    }

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "AURELIA_OWNER_ORIGINS"
        value = var.owner_origins
      }
      env {
        name  = "AURELIA_HTTPS_TERMINATION"
        value = "trusted-proxy"
      }
      env {
        name  = "AURELIA_TRUST_PROXY_HOPS"
        value = "1"
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.firestore_user,
    google_project_iam_member.secret_runtime
  ]
}

# Application routes enforce Firebase authentication and tenant-admin membership.
# Ingress remains restricted to the Google Cloud external Application Load Balancer;
# direct run.app access is disabled above.
resource "google_cloud_run_v2_service_iam_member" "load_balancer_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.payment_backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "cloud_run_service_name" {
  value = google_cloud_run_v2_service.payment_backend.name
}

output "cloud_run_region" {
  value = google_cloud_run_v2_service.payment_backend.location
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "cloud_run_service_uri" {
  value       = google_cloud_run_v2_service.payment_backend.uri
  description = "Internal service URI; direct run.app access is disabled."
}
