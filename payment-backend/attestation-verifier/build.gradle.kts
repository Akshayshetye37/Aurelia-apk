plugins {
    kotlin("jvm") version "2.2.0"
    application
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

dependencies {
    implementation("com.android.keyattestation:keyattestation:0.4")
    implementation("com.google.code.gson:gson:2.11.0")
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("com.aurelia.attestation.MainKt")
}

tasks.shadowJar {
    archiveFileName.set("aurelia-attestation-verifier.jar")
    mergeServiceFiles()
}
