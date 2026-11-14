  assert.ok(enableAfterOwnerAuth > disabled);
  assert.ok(challenge > 0 && credential > challenge && serverAck > credential);