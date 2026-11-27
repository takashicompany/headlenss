# Fieldglass wear test (HeadLenss 2.8.0)

On-glasses protocol for Fieldglass inside the HeadLenss `.ehpk`. One wearer, one partner, the paired iPhone, and the Mac that already runs HeadLenss. No new API keys, no Deepgram, no Mapbox, no new phone login.

Pass only if every hard gate in the last section is PASS. Product gates (latency, useful-cue rate, coverage, false interruptions) use the numbers below. A gate with fewer trials than its minimum is INCONCLUSIVE, not a pass.

Spec v1 is the expected behavior. Where an older mock disagrees (for example double-tap meaning "off target"), the spec wins.

## How to score

Turn **Field test** on before the first scored Start (home card, long-press menu). Leave it on for every session in this document.

After the runs, open the phone web UI → Fieldglass → Field test, and download the CSV (`GET /api/fieldglass/fieldtest.csv`). The sheet at the end lists which `sessionId`s are scored and which are excluded.

| Clock | Meaning |
|---|---|
| `lastWordAt` | ASR time of the last relevant word |
| `candidateAt` | Cue engine published the cue |
| `renderedAt` | Lens update finished (SDK settle) |
| Wearer-visible | Partner's stopwatch: finger up on the last word, wearer says "read" when the hero line is fully on the lens |

Wearer-visible latency is `read − last word`. Log latency is `renderedAt − lastWordAt`. If those two differ by more than 500 ms, flag the trial. It does not count toward a latency PASS until the gap is explained. A `cue_shown` row with no `renderedAt` is a delivery fail for that trial.

The iPhone microphone indicator (orange dot / Dynamic Island) is ground truth for whether the mic is open. The lens must agree with it.

Glyphs to expect: `●` `○` only as specified. Live header on every live screen includes `● LIVE` and a running `mm:ss`. No screen that is not live may **start** with `●`. On every stop, `○ MIC OFF` shows for about 2 seconds.

## Gear

1. Even Realities G2, paired, on the Even app build that can keep running with the phone locked. Record the Even app version and the HeadLenss build (2.8.0).
2. iPhone with the existing HeadLenss server URL and Speechmatics key. Do not enter a new key.
3. Mac on the same tailnet, HeadLenss server already up. Do not restart it for this test.
4. Partner with the script printed. Second phone as a stopwatch only. That recording is outside the product; Fieldglass itself must not store audio.
5. A bright spot (window or outdoors) for session B. The other scored sessions can be indoors.
6. A HeadLenss tmux session the wearer recognizes, for the send check. Do not approve its tool use until the step says so.

## 0. Cold open

Do these once, before any scored session.

1. From the glasses root list, confirm the top row is Fieldglass. It shows the next meeting as `Fieldglass  Next: HH:MM Title`, or `No meetings`, or `Set up calendar on phone`. It does not start with `●`. The orange mic dot is off.
2. Open the row. The home card shows the next meeting and the objective you wrote, or plain setup words if calendar is missing. Tap does not open the mic yet.
3. Long-press. The menu offers Profile (Work / Everyday / Listening), Follow-ups with a count, and Field test. Turn Field test on. Set Profile to Work. Double-tap leaves the menu without starting the mic.
4. On the phone web UI, Today: the same next meeting. Edit the objective, Refresh, and confirm the objective is still there. If calendar is missing, the page shows numbered setup steps in plain language, not a stack trace.
5. Connections: each row has a status (connected, needs sign-in, or not set up), what it is used for, and numbered steps when it is not connected. Check again does not pop a phone login.

## 1. Consent and mic honesty

6. On the home card, Tap. A consent card appears before any audio. The wearer can read that they must tell the room. The orange dot is still off. Header does not start with `●`.
7. Double-tap. Consent cancels. Orange dot stays off. Home card returns. No `● LIVE`.
8. Tap again, tell the partner the mic is going on, then Tap to confirm. Header shows `● LIVE` and `mm:ss` advances every second. Orange dot is on. The body stays empty until a cue. Empty is a valid screen, not a bug.
9. Long-press while live. The menu still shows `● LIVE` and the same running timer. Items include Off target, That was me, Pause cues 15 min, and End session. Close the menu without ending.
10. Double-tap. An end confirm appears. Cancel it (double-tap again or the on-screen back). `● LIVE` is still advancing and the orange dot is still on.
11. Double-tap, confirm end. The header shows `○ MIC OFF` for about 2 seconds. The orange dot goes off within those 2 seconds. It must not stay on after the lens says the mic is off. If it does, stop the whole test. Privacy has failed.

## 2. Scored work sessions

Run this script five times: A indoors, B in daylight, C, D, and E indoors. Four eligible plants fit under the cap of 4 automatic cues per 10 minutes. A new Start each time (steps 6 and 8). After each cue, wait until the body is empty and at least 35 seconds have passed since that cue appeared, then say the next plant. Speak each line once. Do not talk over the cue.

The wearer rates on the glasses: Tap = Useful (and dismiss). Long-press → Off target when it is wrong. Do not rate a cue Useful to be polite. The partner, not the wearer, marks whether the cue matches the plant.

Eligible plants are P1–P4. Resolutions and traps are not coverage misses when they stay silent. If A–E produce fewer than 20 matched cues and coverage is still ≥ 70%, repeat this script until N reaches 20. Stop if coverage falls below 70%.

12. **P1.** Partner: "We still need somebody to run the network check." Expect one cue, category owner or blocker, hero asking who owns that check. One cue only.
13. **Resolve.** While that cue is up, partner: "I'll take the network check." Expect the cue to retract (resolved), not a second card. A commitment may be stored.
14. **P2.** Partner: "The release is blocked on the signing certificate." Expect one blocker cue. Rate it.
15. **P3.** Partner: "Let's decide Thursday or Friday for the demo." Expect one date or decision cue.
16. **Resolve.** Partner: "Let's go with Thursday." Expect that cue to retract. No new card required.
17. **P4.** Partner: "Can someone own the design review notes?" Expect one owner cue.
18. **Expiry (session A only).** Leave the P4 cue up. Nobody speaks for 25 seconds. It leaves on its own (TTL 20 seconds). Body empty. Header still `● LIVE` with the timer advancing. Log reason should be `expired`.
19. **Wearer trap.** Wearer only: "I will send the recap after lunch." Expect no cue. A cue here is a hard fail (wearer's own turn).
20. **Chit-chat trap.** Partner, body empty: "This coffee is terrible." Expect silence. A cue is an irrelevant interruption.
21. **Overlap trap.** Both people talk for about 3 seconds, then only the partner says: "The design review still has no owner." Expect no cue. Four automatic cues have already shown in this session, so another one breaks the cap. A cue that names a person the transcript did not label is also a hard fail. The case where a generic cue is allowed is step 23.
22. **Daylight (session B only).** On the P1 cue, the wearer reads the hero line aloud without cupping the frame or taking the glasses off. Fail the session if they cannot.

End A, B, D, and E with double-tap → confirm, and save nothing (double-tap through review). Session C continues at step 36. Do not run the cooldown or the fifth-cue probe inside A–E. Those belong to section 3, so a correct cap does not eat a scored plant.

## 3. False-interruption add-on (once)

Use a fresh Work session. This session is scored for false interruptions and the rate cap only. Exclude its `sessionId` from latency and coverage.

23. Both people talk for about 3 seconds, then only the partner says: "The design review still has no owner." Silence is pass. One generic cue ("Who owns…") is pass. A cue that names a person the transcript did not label ("Ask Dana") is a hard fail. If a cue showed, wait until the body is empty before the next step. It counts toward this session's cap of 4.
24. Partner says P1. When that cue appears, they immediately say: "We also need an owner for the backup restore." A second automatic cue within 30 seconds is a hard fail. Suppression is pass. If step 23 already showed a cue, wait until the body has been empty for 35 seconds before this line.
25. After the body is empty and 35 seconds have passed, keep planting P2, P3, and P4 until this session has shown 4 automatic cues. Then, still inside 10 minutes of the first of those cues, say one more eligible line. Expect no fifth automatic cue. A fifth is a hard fail.
26. Fill the rest of that 10 minutes with chit-chat and wearer-only sentences ("I need water", "the train was late"). Every cue in that stretch is irrelevant.

## 4. Listening, Everyday, mute

27. New session, Profile **Listening**, Field test still on. Partner: "I'm worried the Friday demo will slip." Expect one concern or recall cue. An owner, date, decision, or blocker cue is a fail.
28. Partner: "Who is going to own the network check?" Expect silence. An owner cue is a fail.
29. Wearer: "I'm worried too." Expect silence.
30. End session. `○ MIC OFF`, orange dot off.
31. Profile **Everyday**. Partner, after Start: "We still need somebody to run the network check." Expect one cue, and the header must show Everyday, not Work. Wearer then says "I'll handle it myself." Expect no cue on that turn.
32. **Mute.** Profile Work. Three times, plant P2 ("signing certificate"), wait out the 35 second gap, and rate each cue Off target. The third Off target mutes blocker for Work.
33. Wait until 10 minutes after the first of those three cues, so the rate cap is not why the next one is quiet. Plant P2 again. Expect no blocker cue.
34. Leave Fieldglass to the root list, open it again, Start, plant P2. Expect still no blocker cue (the mute survived leaving the screen).
35. Reset the mute the way the build provides (phone or glasses). Plant P2 again. Expect a blocker cue. If there is no way to unmute, this step fails.

Exclude session ids from steps 23–35 from the latency median.

## 5. Privacy

Do this on session C, after P4 has been rated, and on the Mac and phone after End.

36. End session C. Review shows commitments (quote, optional owner, optional due), not the full transcript and not a waveform. Swipe moves between rows.
37. Tap one commitment whose quote is exactly a partner line from this session (the network-check line or the Thursday line). It saves. Leave at least one other commitment unsaved. Double-tap done.
38. Lens shows `○ MIC OFF` for about 2 seconds. Orange dot off. The transcript is not on the lens anymore.
39. Start a new session and say nothing for 10 seconds. The previous partner line must not reappear as a cue or as review text. End it. Orange dot off.
40. Phone web UI → Follow-ups. The saved quote is there, verbatim. The unsaved quote is absent. The unsent row shows an expiry about 7 days from the save (± 5 minutes). You cannot sit this test out for 7 days: record "auto-delete at expiry not observed." A missing expiry on an unsent row is a fail.
41. On the Mac, look only in `~/.headlenss/fieldglass/` (or `HEADLENSS_FIELDGLASS_DIR` if the server was started with one). The saved follow-up is there. There is no audio file (no wav, pcm, m4a, webm, ogg, mp3, flac) and no file that holds the unsaved transcript or the raw session text. Nothing in this folder is a copy of the audio.
42. Follow-ups → Send, and pick the HeadLenss session from the gear list. The session must receive a prompt that contains the quote verbatim, the owner, the due, the meeting title, and the instruction to ask before sending or creating anything. Do not approve the permission card. Confirm nothing arrived in Slack, Gmail, Notion, ClickUp, or Calendar from this action. Dismiss the permission the usual HeadLenss way.
43. Send again only if you intend to approve. Approving is optional. If you approve, the existing permission flow is what performs the tool call. Fieldglass must not have written the tool itself.
44. Privacy tab → Delete all Fieldglass data. Follow-ups are gone on the phone and the Mac directory no longer holds them. Today objectives written by Fieldglass are gone. A later Today refresh may refill events from calendar; it must not restore the deleted objective or the deleted quote.
45. Root list, home card, consent, review, and follow-ups: none of those headers start with `●` while the mic is off.

## 6. Phone lock and reconnect

Fresh Work session, Field test on. Exclude this `sessionId` from latency, useful rate, and coverage. It is the lock/reconnect gate only.

46. Start live (consent, then Tap). Say P1. When the cue is on the lens and `● LIVE` is advancing, lock the iPhone. Wait 20 seconds.
47. Watch the lens the whole time. Pass if **either** (a) the timer keeps advancing and a new partner line still produces a cue, **or** (b) within 3 seconds of the timer stalling, the header is no longer `● LIVE`, the old cue is gone, and the lens shows `○ MIC OFF` or a named disconnect state. Fail if the header says `● LIVE` while `mm:ss` is frozen, or a cue sits there looking current after the mic has stopped.
48. Compare the orange dot while locked (glance the lock screen). Dot on only if the lens still says `● LIVE` with a moving timer. Dot off if the lens has left LIVE.
49. Unlock. The lens is either still in that live session, or on the home card with the mic off. It is not a new cue built from speech from before the lock. Start works again if the session died. No second orange dot, no stuck "connecting" with a dead timer.
50. Live again. Partner starts P2. Turn airplane mode on for 10 seconds, then off. Pass if the next full partner sentence after the network returns produces a cue, or the lens leaves LIVE and Start works on the first try. Fail if the mic stays on with no `● LIVE`, if a half sentence becomes a saved quote, or if Start does nothing and the orange dot stays on.
51. Live again, body empty. Have someone send an iMessage (or any app notification the Even app is allowed to show). When the notification clears, Fieldglass is back on the screen it was on, or on the home card with `○ MIC OFF`. The wearer can still end the session or Start again. Fail if the message replaces Fieldglass and there is no way back without killing the Even app, or if `● LIVE` continues under a notification the wearer cannot dismiss from the ring.

End with step 11's stop check ( `○ MIC OFF`, orange dot off ).

## 7. Compute the product numbers

Use only scored sessions (A–E and any repeats you ran to reach N = 20). Drop flagged trials (clock gap > 500 ms) from the latency math and list them. Do not drop them from coverage: a flagged shown cue still counts as shown.

52. **Latency sample.** Rows with `kind = cue_shown` whose text matches P1–P4 in scored sessions only. N must be ≥ 20 to score the gate. Sort `renderedAt − lastWordAt` ascending. Median: if N is odd, the middle value; if even, the mean of the two middle values. 95th percentile: the value at rank `ceil(0.95 × N)`. Also report the median of `candidateAt − lastWordAt` (engine) and `renderedAt − candidateAt` (delivery). Those splits are diagnostic. They do not have their own gate.
53. **Useful-cue rate.** Denominator: every `cue_shown` in scored sessions. Numerator: the wearer tapped Useful **and** the partner marked the cue as matching an open plant. A Useful tap on a non-matching cue counts as not useful.
54. **Coverage.** Denominator: P1–P4 actually spoken in scored sessions (20 if A–E were each completed once). Numerator: a matching cue shown before the next plant. Cooldown and cap probes in steps 23–25 are not in this denominator.
55. **False interruptions.** An irrelevant cue is a `cue_shown` that matches no open plant, including wearer turns, chit-chat, overlap garbage, and Listening leaks. LIVE minutes come from `session_start` / `session_end` (subtract pauses if the log has them; if it does not, use wall-clock time the header said LIVE). Rate = irrelevant cues per 10 LIVE minutes, on scored sessions plus section 3.

## Acceptance gates

### Product gates

| Gate | Pass | Fail / inconclusive |
|---|---|---|
| Latency | N ≥ 20 matched cues in scored sessions, median ≤ 1.5 s, 95th percentile ≤ 3.0 s, no unflagged trial missing `renderedAt` | Above either number, or any scored cue with no `renderedAt`. N < 20 → INCONCLUSIVE |
| Useful-cue rate | ≥ 80% of `cue_shown` in scored sessions | Below 80% |
| Coverage | ≥ 70% of eligible plants in scored sessions | Below 70% |
| False interruptions | ≤ 1 irrelevant cue per rolling 10 LIVE minutes, and none on a wearer-only turn | 2 or more in any 10 LIVE minutes, or any wearer-turn cue |

### Hard gates (any one fail fails the build)

| Gate | Pass |
|---|---|
| Privacy: consent | No audio before the consent Tap. Cancel never starts the mic (steps 6–7, 45). |
| Privacy: indicator | `● LIVE mm:ss` on every live screen, timer moving. `○ MIC OFF` about 2 s on every stop. Orange dot agrees. No non-live header starts with `●` (steps 8–11, 45). |
| Privacy: retention | No raw audio anywhere Fieldglass writes. Transcript gone at session end. Only a Tap-saved quote is on the Mac. Unsent expiry ≈ 7 days. Delete all removes quotes and objectives (steps 36–44). Auto-delete at day 7 is not claimed from this sitting. |
| Privacy: send | Send only hands the quote to a chosen HeadLenss session and asks before creating or sending. Nothing reaches Slack or email unless that permission flow is approved (steps 42–43). |
| Speaker honesty | No speaker-specific cue when the speaker label is missing. Unknown speaker never becomes a named person (steps 21, 23). |
| One cue and policy | One visible cue. Retract on "I'll take it", a date chosen, or "let's go with…". Cooldown 30 s. Cap 4 automatic cues / 10 min. TTL about 20 s. Listening emits only concern or recall (steps 12–18, 23–25, 27–28). |
| Mute | Three Off target ratings on one category in one profile mute it, including after leaving Fieldglass. There is a way to unmute, and the next plant of that category shows again (steps 32–35). |
| Phone lock | No frozen `● LIVE`. Mic dot and lens agree. Unlock does not replay old speech as a new cue (steps 46–49). |
| Reconnect | Airplane-mode drop and an iMessage takeover each end in a live session that still works or a mic-off home card the wearer can Start again. No orphaned orange dot (steps 50–51, 11). |
| Daylight | Session B hero line readable without shielding the lens (step 22). |
| Setup | No new key, no new login. Today objective survives Refresh. Root row matches the phone (steps 1–5). |

## Score sheet

| Item | Value |
|---|---|
| Date, Even app version, HeadLenss 2.8.0 build | |
| Scored session ids (A–E and any repeats) | |
| Excluded session ids (sections 3, 4, 6) | |
| N latency / median / 95th (ms) | |
| Median engine / median delivery (ms) | |
| Flagged clock-gap trials | |
| Useful / cue_shown | |
| Covered / eligible plants | |
| Irrelevant cues and LIVE minutes | |
| Hard gates (name any FAIL) | |
| Auto-delete at day 7 | Not observed |
| Tester | |

Ship only if every hard gate is PASS and all four product gates are PASS. INCONCLUSIVE is not a ship.
