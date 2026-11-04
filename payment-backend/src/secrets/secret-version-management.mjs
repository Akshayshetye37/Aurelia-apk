/**
 * Disable a tenant provider secret's latest version without deleting the
 * Secret Manager resource. Keeping the resource permits safe credential
 * replacement while removing project-wide secret deletion authority.
 */
export async function disableLatestSecretVersion(client, secretResourceName) {
  if (!client || typeof client.getSecretVersion !== "function" ||
      typeof client.disableSecretVersion !== "function" ||
      typeof secretResourceName !== "string" ||
      !/^projects\/[A-Za-z0-9-]+\/secrets\/[A-Za-z0-9_-]{1,255}$/.test(secretResourceName)) {
    throw new TypeError("secret_version_management_dependencies_required");
  }

  let version;
  try {
    [version] = await client.getSecretVersion({
      name: secretResourceName + "/versions/latest"
    });
  } catch (error) {
    if (error?.code === 5) return { alreadyAbsent: true, disabled: false };
    throw error;
  }

  if (!version || typeof version.name !== "string") {
    throw new Error("secret_version_metadata_invalid");
  }
  if (version.state === "DISABLED" || version.state === "DESTROYED") {
    return { alreadyAbsent: false, disabled: false, alreadyDisabled: true };
  }
  if (version.state !== "ENABLED") {
    throw new Error("secret_version_state_unrecognized");
  }

  await client.disableSecretVersion({ name: version.name });
  return { alreadyAbsent: false, disabled: true };
}
