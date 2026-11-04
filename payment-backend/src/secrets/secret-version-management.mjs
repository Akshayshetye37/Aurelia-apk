/**
 * Disable every enabled version of a tenant provider secret without deleting
 * the Secret Manager resource. Retaining the resource permits safe credential
 * replacement while revoking all previously stored provider credentials.
 */
export async function disableAllEnabledSecretVersions(client, secretResourceName) {
  if (!client || typeof client.listSecretVersionsAsync !== "function" ||
      typeof client.disableSecretVersion !== "function" ||
      typeof secretResourceName !== "string" ||
      !/^projects\/[A-Za-z0-9-]+\/secrets\/[A-Za-z0-9_-]{1,255}$/.test(secretResourceName)) {
    throw new TypeError("secret_version_management_dependencies_required");
  }

  let disabledCount = 0;
  try {
    for await (const version of client.listSecretVersionsAsync({
      parent: secretResourceName,
      filter: "state:ENABLED"
    })) {
      if (!version || typeof version.name !== "string" ||
          !(version.state === "ENABLED" || version.state === 1)) {
        throw new Error("secret_version_metadata_invalid");
      }
      await client.disableSecretVersion({ name: version.name });
      disabledCount++;
    }
  } catch (error) {
    if (error?.code === 5 && disabledCount === 0) {
      return { alreadyAbsent: true, disabledCount: 0 };
    }
    throw error;
  }

  return { alreadyAbsent: false, disabledCount };
}
