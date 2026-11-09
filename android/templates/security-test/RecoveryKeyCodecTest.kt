package com.aurelia.pms.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryKeyCodecTest {
    @Test
    fun generatedKeyHas160BitsAndRoundTripsThroughGroupedBase32() {
        val generated = RecoveryKeyCodec.generate()
        try {
            assertEquals(8, generated.concatToString().split("-").size)
            val decoded = RecoveryKeyCodec.decode(generated)
            try {
                assertEquals(20, decoded.size)
                val encoded = RecoveryKeyCodec.encode(decoded)
                try {
                    assertArrayEquals(generated, encoded)
                } finally {
                    encoded.fill('\u0000')
                }
            } finally {
                decoded.fill(0)
            }
        } finally {
            generated.fill('\u0000')
        }
    }

    @Test
    fun confirmationIsCaseAndSeparatorInsensitiveButRejectsDifferentSecrets() {
        val generated = RecoveryKeyCodec.generate()
        val normalized = generated.concatToString().lowercase().replace("-", "").toCharArray()
        try {
            assertTrue(RecoveryKeyCodec.matches(generated, normalized))
            normalized[0] = if (normalized[0] == 'a') 'b' else 'a'
            assertFalse(RecoveryKeyCodec.matches(generated, normalized))
        } finally {
            generated.fill('\u0000')
            normalized.fill('\u0000')
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun malformedAndShortKeysAreRejected() {
        RecoveryKeyCodec.decode("ABC-123".toCharArray())
    }

    @Test(expected = IllegalArgumentException::class)
    fun ambiguousBase32CharactersAreRejected() {
        RecoveryKeyCodec.decode("0".repeat(32).toCharArray())
    }
}
