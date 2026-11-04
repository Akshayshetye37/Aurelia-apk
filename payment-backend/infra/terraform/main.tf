locals {
  required_apis = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "compute.googleapis.com"
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

resource "google_secret_manager_secret" "backend_health" {
  project   = var.project_id
  secret_id = "aurelia-payment-backend-health"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
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
    "secretmanager.secrets.delete",
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
  provider             = google-beta
  launch_stage         = "BETA"
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

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 5
        failure_threshold    = 12

        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      liveness_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 30
        failure_threshold    = 3

        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      readiness_probe {
        timeout_seconds   = 3
        period_seconds    = 10
        failure_threshold = 2
        success_threshold = 1

        http_get {
          path = "/readyz"
          port = 8080
        }
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
    google_project_iam_member.secret_runtime,
    google_secret_manager_secret.backend_health
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

resource "google_compute_region_network_endpoint_group" "payment_backend" {
  project               = var.project_id
  name                  = "${var.service_name}-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.payment_backend.name
  }

  depends_on = [google_cloud_run_v2_service.payment_backend]
}

resource "google_compute_security_policy" "payment_backend" {
  project     = var.project_id
  name        = "${var.service_name}-edge-policy"
  description = "Rate limits public payment API ingress before Cloud Run."

  rule {
    action      = "throttle"
    priority    = 1000
    description = "Bound request bursts per source IP."

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow after explicit edge throttling."

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_backend_service" "payment_backend" {
  project               = var.project_id
  name                  = "${var.service_name}-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30
  security_policy       = google_compute_security_policy.payment_backend.id

  backend {
    group = google_compute_region_network_endpoint_group.payment_backend.id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "payment_backend" {
  project         = var.project_id
  name            = "${var.service_name}-url-map"
  default_service = google_compute_backend_service.payment_backend.id
}

resource "google_compute_managed_ssl_certificate" "payment_backend" {
  project = var.project_id
  name    = "${var.service_name}-managed-cert"

  managed {
    domains = [var.domain_name]
  }
}

resource "google_compute_ssl_policy" "payment_backend" {
  project         = var.project_id
  name            = "${var.service_name}-tls-policy"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "payment_backend" {
  project          = var.project_id
  name             = "${var.service_name}-https-proxy"
  url_map          = google_compute_url_map.payment_backend.id
  ssl_certificates = [google_compute_managed_ssl_certificate.payment_backend.id]
  ssl_policy       = google_compute_ssl_policy.payment_backend.id
}

resource "google_compute_global_address" "payment_backend" {
  project      = var.project_id
  name         = "${var.service_name}-global-ip"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_global_forwarding_rule" "payment_backend_https" {
  project               = var.project_id
  name                  = "${var.service_name}-https"
  target                = google_compute_target_https_proxy.payment_backend.id
  ip_address            = google_compute_global_address.payment_backend.address
  port_range            = "443"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "${var.service_name}-http-redirect"

  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "payment_backend" {
  project = var.project_id
  name    = "${var.service_name}-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "payment_backend_http" {
  project               = var.project_id
  name                  = "${var.service_name}-http"
  target                = google_compute_target_http_proxy.payment_backend.id
  ip_address            = google_compute_global_address.payment_backend.address
  port_range            = "80"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

output "load_balancer_ip" {
  value       = google_compute_global_address.payment_backend.address
  description = "Create an A record for domain_name pointing to this global HTTPS load balancer IP."
}

output "payment_backend_https_url" {
  value       = "https://${var.domain_name}"
  description = "Public HTTPS endpoint routed through the managed global load balancer."
}
