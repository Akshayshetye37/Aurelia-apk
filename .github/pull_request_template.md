## Packet and scope
- Packet: `R1-__`
- Scope:
- Dependencies:
- External blockers (people/devices/credentials/backup/sign-off):

## Definition of Done
Use the packet-specific exit gate in [R1 packet Definition of Done](../docs/DEFINITION_OF_DONE.md).

- [ ] Success path tested.
- [ ] Failure path tested (fault injected at every durable write step; no partial state).
- [ ] Restart/recovery tested (persist, kill/force-stop, reopen, compare hashes/read-back).
- [ ] Integration with dependent modules tested.
- [ ] Required checks green on this exact PR head/release SHA.
- [ ] Packet-specific exit criteria all satisfied.
- [ ] All external evidence/sign-offs attached; none simulated.

**Rule:** Any unchecked box means this packet remains **In progress** or **Blocked**. Do not start the next packet until this packet is accepted, merged, and green. Do not merge or release without explicit owner authorization.

## Verification evidence
- Exact tested SHA:
- CI run(s):
- Fault-injection/recovery evidence:
- Integration evidence:
- Human/device/owner evidence:
- Known limitations:
