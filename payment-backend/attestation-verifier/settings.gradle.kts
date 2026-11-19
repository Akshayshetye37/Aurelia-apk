pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "aurelia-attestation-verifier"

includeBuild("/opt/keyattestation") {
    dependencySubstitution {
        substitute(module("com.android.keyattestation:keyattestation")).using(project(":"))
    }
}
