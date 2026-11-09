package com.aurelia.pms.security

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * In-memory recovery-secret generation and Base32 codec.
 *
 * The caller owns returned character arrays and must clear them after display
 * and confirmation. This class never persists or logs recovery material.
 */
object RecoveryKeyCodec {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    private const val SECRET_BYTES = 20
    private const val SECRET_SYMBOLS = 32
    private const val GROUP_SIZE = 4

    @JvmStatic
    fun generate(random: SecureRandom = SecureRandom()): CharArray {
        val secret = ByteArray(SECRET_BYTES)
        return try {
            random.nextBytes(secret)
            encode(secret)
        } finally {
            secret.fill(0)
        }
    }

    @JvmStatic
    fun encode(secret: ByteArray): CharArray {
        require(secret.size == SECRET_BYTES) { "Recovery secret must contain exactly 160 bits." }
        val symbols = CharArray(SECRET_SYMBOLS)
        var buffer = 0
        var bits = 0
        var index = 0
        for (byte in secret) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                symbols[index++] = ALPHABET[(buffer ushr bits) and 31]
            }
        }
        require(index == SECRET_SYMBOLS && bits == 0)
        val grouped = CharArray(SECRET_SYMBOLS + (SECRET_SYMBOLS / GROUP_SIZE - 1))
        var output = 0
        for (i in symbols.indices) {
            if (i > 0 && i % GROUP_SIZE == 0) grouped[output++] = '-'
            grouped[output++] = symbols[i]
        }
        symbols.fill('\u0000')
        return grouped
    }

    @JvmStatic
    fun decode(input: CharArray): ByteArray {
        val compact = CharArray(SECRET_SYMBOLS)
        var count = 0
        try {
            for (character in input) {
                if (character == '-' || character.isWhitespace()) continue
                require(count < SECRET_SYMBOLS) { "Recovery secret has too many symbols." }
                val normalized = character.uppercaseChar()
                require(ALPHABET.indexOf(normalized) >= 0) { "Recovery secret contains an invalid Base32 symbol." }
                compact[count++] = normalized
            }
            require(count == SECRET_SYMBOLS) { "Recovery secret must contain exactly 160 bits." }

            val decoded = ByteArray(SECRET_BYTES)
            var buffer = 0
            var bits = 0
            var output = 0
            for (character in compact) {
                buffer = (buffer shl 5) or ALPHABET.indexOf(character)
                bits += 5
                if (bits >= 8) {
                    bits -= 8
                    decoded[output++] = ((buffer ushr bits) and 0xff).toByte()
                }
            }
            require(output == SECRET_BYTES && bits == 0) { "Recovery secret encoding is malformed." }
            return decoded
        } finally {
            compact.fill('\u0000')
        }
    }

    @JvmStatic
    fun matches(expected: CharArray, entered: CharArray): Boolean {
        var expectedBytes: ByteArray? = null
        var enteredBytes: ByteArray? = null
        return try {
            expectedBytes = decode(expected)
            enteredBytes = decode(entered)
            MessageDigest.isEqual(expectedBytes, enteredBytes)
        } catch (_: IllegalArgumentException) {
            false
        } finally {
            expectedBytes?.fill(0)
            enteredBytes?.fill(0)
        }
    }
}
