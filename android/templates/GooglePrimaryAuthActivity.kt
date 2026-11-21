package com.aurelia.pms.identity

import androidx.activity.ComponentActivity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.functions.FirebaseFunctions


import kotlinx.coroutines.launch

/** Google-only primary identity gate. Recovery Phone Auth uses a separate FirebaseApp. */
class GooglePrimaryAuthActivity : ComponentActivity() {
    companion object {
        const val EXTRA_SWITCH_ACCOUNT = "switch_google_account"
        private const val REGION = "asia-south1"
    }

    private lateinit var credentials: CredentialManager
    private lateinit var status: TextView
    private lateinit var button: Button
    private var generation = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        credentials = CredentialManager.create(this)
        render()
        if (intent.getBooleanExtra(EXTRA_SWITCH_ACCOUNT, false)) {
            FirebaseAuth.getInstance().signOut()
            lifecycleScope.launch {
                runCatching { credentials.clearCredentialState(ClearCredentialStateRequest()) }
                requestGoogle()
            }
            return
        }
        val current = FirebaseAuth.getInstance().currentUser
        if (current != null && current.providerData.any { it.providerId == "google.com" }) {
            bindOwner(current.uid)
        } else {
            if (current != null) FirebaseAuth.getInstance().signOut()
            requestGoogle()
        }
    }

    private fun render() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(40, 48, 40, 48)
            setBackgroundColor(android.graphics.Color.rgb(5, 17, 13))
        }
        root.addView(TextView(this).apply {
            text = "Sign in to Aurelia"
            textSize = 24f
            gravity = Gravity.CENTER
            setTextColor(android.graphics.Color.WHITE)
        })
        status = TextView(this).apply {
            text = "Google account authentication is required."
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(android.graphics.Color.LTGRAY)
            setPadding(0, 24, 0, 24)
        }
        button = Button(this).apply {
            text = "Continue with Google"
            setOnClickListener { requestGoogle() }
        }
        root.addView(status, LinearLayout.LayoutParams(-1, -2))
        root.addView(button, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
    }

    private fun requestGoogle() {
        val webClientId = getString(R.string.aurelia_google_web_client_id).trim()
        if (!webClientId.matches(Regex("^[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com$"))) {
            status.text = "Google Sign-In is not configured for this build. Add Firebase config and the Web OAuth client ID."
            button.isEnabled = true
            return
        }
        val requestGeneration = ++generation
        button.isEnabled = false
        status.text = "Choose your Google account…"
        lifecycleScope.launch {
            try {
                val googleOption = GetGoogleIdOption.Builder()
                    .setServerClientId(webClientId)
                    .setFilterByAuthorizedAccounts(false)
                    .setAutoSelectEnabled(false)
                    .build()
                val request = GetCredentialRequest.Builder().addCredentialOption(googleOption).build()
                val result = credentials.getCredential(this@GooglePrimaryAuthActivity, request)
                if (requestGeneration != generation || isFinishing) return@launch
                val credential = result.credential
                if (credential !is CustomCredential ||
                    credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    fail("Google ID token credential was not returned.")
                    return@launch
                }
                val googleCredential = GoogleIdTokenCredential.createFrom(credential.data)
                val idToken = googleCredential.idToken
                if (idToken.isBlank()) {
                    fail("Google returned an empty ID token.")
                    return@launch
                }
                FirebaseAuth.getInstance().signInWithCredential(GoogleAuthProvider.getCredential(idToken, null))
                    .addOnCompleteListener(this@GooglePrimaryAuthActivity) { task ->
                        if (requestGeneration != generation || isFinishing) return@addOnCompleteListener
                        val user = if (task.isSuccessful) task.result?.user else null
                        if (user == null || user.providerData.none { it.providerId == "google.com" }) {
                            FirebaseAuth.getInstance().signOut()
                            fail("Google authentication failed. Try again.")
                        } else bindOwner(user.uid)
                    }
            } catch (failure: GetCredentialException) {
                if (requestGeneration == generation && !isFinishing) {
                    fail(if (failure is androidx.credentials.exceptions.GetCredentialCancellationException)
                        "Sign-in cancelled." else "No Google account was selected or the request failed.")
                }
            } catch (_: Exception) {
                if (requestGeneration == generation && !isFinishing) fail("Google Sign-In failed. Check your network and try again.")
            }
        }
    }

    private fun bindOwner(uid: String) {
        val requestGeneration = ++generation
        button.isEnabled = false
        status.text = "Verifying owner membership…"
        FirebaseFunctions.getInstance(REGION).getHttpsCallable("ensureOwnerMembership")
            .call(emptyMap<String, Any>())
            .addOnCompleteListener(this) { task ->
                if (requestGeneration != generation || isFinishing) return@addOnCompleteListener
                if (!task.isSuccessful || FirebaseAuth.getInstance().currentUser?.uid != uid) {
                    FirebaseAuth.getInstance().signOut()
                    fail("Owner membership could not be verified. Sign in again.")
                    return@addOnCompleteListener
                }
                val payload = task.result?.data as? Map<*, *>
                val memberships = payload?.get("memberships") as? List<*>
                val membership = memberships?.firstOrNull() as? Map<*, *>
                val ownerId = membership?.get("ownerId") as? String
                if (ownerId.isNullOrBlank()) {
                    FirebaseAuth.getInstance().signOut()
                    fail("The server returned an invalid owner membership.")
                    return@addOnCompleteListener
                }
                startActivity(Intent(this, com.aurelia.pms.security.LockGateActivity::class.java)
                    .putExtra("primary_uid", uid)
                    .putExtra("primary_owner_id", ownerId))
                finish()
            }
    }

    private fun fail(message: String) {
        status.text = message
        button.isEnabled = true
    }

    override fun onDestroy() {
        generation++
        super.onDestroy()
    }
}
