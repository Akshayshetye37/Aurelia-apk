variable "project_id" {
  description = "Google Cloud project that owns Cloud Run, Firestore and Secret Manager."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
  default     = "asia-south1"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "aurelia-payment-backend"
}

variable "container_image" {
  description = "Immutable Artifact Registry image reference (prefer a digest, not latest)."
  type        = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.container_image))
    error_message = "container_image must be pinned to an immutable sha256 digest."
  }
}

variable "owner_origins" {
  description = "Comma-separated exact HTTPS origins allowed by the payment API."
  type        = string
  validation {
    condition     = length(var.owner_origins) > 0 && alltrue([for origin in split(",", var.owner_origins) : can(regex("^https://[^/]+$", trimspace(origin)))])
    error_message = "Every owner origin must be an exact HTTPS origin with no path."
  }
}

variable "max_instance_count" {
  description = "Maximum Cloud Run instances."
  type        = number
  default     = 5
}
