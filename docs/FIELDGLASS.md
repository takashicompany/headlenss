# Fieldglass

Fieldglass is the meeting helper inside HeadLenss on your Even G2 glasses. It shows one short hint while other people are talking, then lets you save the exact words of a promise as a follow-up.

You do not create a new account. You do not add a new key. Fieldglass uses the HeadLenss server address and the speech key already saved on your phone.

Maps and text-message alerts stay in the Even app. Fieldglass does not replace them. Asking Claude or Codex is still a normal HeadLenss session.

The glasses follow the language you already chose in HeadLenss (English or Japanese).

## Set up in three steps

**1. Open HeadLenss on the glasses, the same way you already do.**

Fieldglass is the first row in the list. It looks like:

`Fieldglass  Next: 10:00 Standup`

If that row is missing, HeadLenss on the glasses is older than version 2.8.0. Update HeadLenss in Even Hub, then open it again. Use the same server address and the same speech key. Do not type them again.

**2. Tap Fieldglass.**

You should see the next meeting and the objective you wrote for it. That is the whole daily setup. Tap again only when you are in the room and ready to listen.

If the row says `No meetings`, there is nothing on the calendar for the rest of the day. You can still start a live session from the Fieldglass card.

**3. Only if the glasses say `Set up calendar on phone`.**

On your phone, open the HeadLenss page you already use in the browser. Open **Fieldglass**, then **Connections**. Find **Google Calendar**. Follow the numbered steps on that page. When you finish, tap **Check again**. Then open **Today** and tap **Refresh**.

Wait. Looking up the calendar can take a few minutes. It does not finish the instant you tap. When it is ready, the next meeting appears on the phone and on the glasses. You do not need to tap Refresh again while it says it is still working.

After the meeting appears, type the objective on the phone under that meeting (what you want out of it). The objective stays put when the calendar updates later.

## What each screen means

### Glasses: the session list

The top row is Fieldglass, then your usual sessions.

- `Next: 10:00 Standup` means the next meeting HeadLenss could read from the calendar.
- `No meetings` means the calendar answered and nothing is coming up.
- `Set up calendar on phone` means the calendar is not available yet. Do step 3 above. Do not hunt for this inside the Even app.

Tap the Fieldglass row to open it. A swipe moves through the rest of the list, the same as before.

### Glasses: the meeting card

This is home. You see the next meeting and your objective. The microphone is off.

Nothing is being heard on this screen.

### Glasses: “Tell the room…”

This screen appears only after you choose to start. Read it and tell the people with you that a live helper is on. The microphone is still off.

### Glasses: live, with an empty body

The microphone is on. A filled dot in the header means that, and only that:

`● LIVE` plus the minutes and seconds.

An empty body is normal. Fieldglass stays quiet until someone else raises something worth a hint. Your own words never become a hint.

### Glasses: a cue

One hint at a time. The header looks like:

`CUE · Work  ● LIVE 2:14`

The large line is the hint (for example, “Who owns the network check?”). The smaller lines say why. The hint does not name a person unless the glasses already know who was speaking. If the voice is unknown, you will not get a hint that depends on who said it.

The hint leaves on its own after about 20 seconds, or sooner if the room resolves it (someone takes it, a date is set, or a choice is made).

### Glasses: saved lines, after you stop

You see promises the glasses picked out, using the words that were actually said. Nothing has been stored yet. Each line is still only on the phone until you save it.

### Glasses: mic off

`○ MIC OFF` shows for about two seconds after you finish. The transcript is already gone from the phone. No other screen uses a filled dot. If you ever see `●`, you are live.

### Phone: Fieldglass

Open it from the HeadLenss page in the phone browser.

| Tab | What it is for |
|---|---|
| Today | Today’s meetings, your objective for each one, and Refresh. If the calendar is missing, the setup steps are on this tab too. |
| Follow-ups | Quotes you saved. You can fix the wording, the owner, and the due time. You can send one to a HeadLenss session or delete it. Each one shows when it will be removed. |
| Connections | Each service on the Mac: connected, needs sign-in, or not set up. What Fieldglass uses it for. Numbered steps when it is not ready. **Check again** re-reads the list. |
| Privacy | What is kept, where, and for how long. **Delete all Fieldglass data** is here. |
| Field test | Optional timing log for a wear test, plus a download of that log. Leave it off for normal days. |

## Gestures

Long-press opens the glasses’ hold menu. Fieldglass adds its own lines to that menu.

| Screen | Tap | Swipe | Double-tap | Long-press |
|---|---|---|---|---|
| Meeting card | Go to the “Tell the room…” screen | — | Back to the session list | Profile (Work, Everyday, or Listening). Follow-ups and how many are waiting. Field test on or off |
| “Tell the room…” | Turn the microphone on | — | Cancel. The mic stays off | — |
| Live, no hint yet | — | — | End the session. The glasses ask you to confirm | That was me. Pause hints for 15 minutes. End session |
| A cue is showing | Mark it useful. The hint leaves | — | End the session. The glasses ask you to confirm | Off target. That was me. Pause hints for 15 minutes. End session |
| Saved lines | Save this quote to your Mac | Move to the next or previous quote | Done | — |

Work is the profile to use in a working meeting. Listening stays quiet except when someone raises a worry or asks to recall something. Everyday is the other profile on that menu; use it outside a formal meeting.

**That was me** tells Fieldglass the last voice was yours, so it stops treating it as someone else.

**Pause hints for 15 minutes** stops new hints. The microphone stays on until you end the session. `● LIVE` stays in the header.

**Off target** means this kind of hint was wrong. The hint leaves. Three Off target ratings for the same kind of hint, on the same profile, turn that kind off until you change profile.

Ending a session always asks you to confirm, because the transcript is dropped as soon as you finish the saved-lines screen.

## What the profiles listen for

Hints are only about:

- who will own something
- a date or deadline
- a decision
- a blocker
- a concern
- a request to recall something

Listening uses only the last two. There is at most one hint on screen. A new automatic hint waits at least 30 seconds after the previous one, and there are at most four automatic hints in any 10 minutes.

## Follow-ups

A follow-up is a quote you chose to keep, plus an owner and a due time if you have them.

Saving copies that quote to your Mac. It does not email anyone and it does not post to Slack.

**Send** on the phone picks one HeadLenss session and hands it this job: here is the quote, the owner, the due time, and the meeting name; draft a task in the tool you normally use; ask before sending or creating anything. Claude still has to ask permission before it uses a tool, the same way it already does.

If you never send a follow-up, it is deleted from the Mac 7 days after you saved it.

## Privacy

- The microphone starts only after you tap Start and then tap again on “Tell the room…”.
- While it is on, every live screen shows `● LIVE` and a timer. When you stop, you see `○ MIC OFF` for about two seconds.
- The audio is not saved. HeadLenss uses the speech service already configured on the phone to turn speech into text. The text stays in memory on the phone for this session only.
- When the session ends, that text is dropped. It is not written to the phone and it is not written to the Mac.
- The only words that leave the phone are quotes you tap to save. They are stored on your Mac, in HeadLenss’s Fieldglass folder, not on a separate Fieldglass account.
- Nothing is sent to Slack, email, or any other service unless you tap Send, and even then Claude must ask you before it creates or sends anything.
- Fieldglass does not build a profile of people and does not score them.
- The calendar is read on the Mac in the background, through the Google Calendar connection Claude already has. That lookup is not your meeting transcript.
- Field test, if you turned it on, stores timing notes (when a hint appeared and how you rated it) on the Mac. It does not store the transcript.
- **Delete all Fieldglass data** on the phone’s Privacy tab removes the meetings cache, objectives, follow-ups, connection snapshot, and field-test log from the Mac. It does not delete your HeadLenss sessions or your Claude logins.

## When something looks wrong

**The Fieldglass row is not in the list.**

Update HeadLenss on the glasses to 2.8.0 from Even Hub. Open HeadLenss again. Do not enter a new server address or a new speech key.

**The glasses say `Set up calendar on phone`.**

1. On the phone browser, open your usual HeadLenss page.
2. Open Fieldglass → Connections → Google Calendar.
3. Do the numbered steps on that card.
4. Tap **Check again**. The status should say connected.
5. Open Today and tap **Refresh** once.
6. Wait several minutes. The glasses update from the phone’s result. Leave the “still working” state alone.

**Refresh never finishes.**

Wait up to about six minutes. If it is still not done, open Connections, tap **Check again**, confirm Google Calendar says connected, then tap **Refresh** one more time. If the status says it needs sign-in, the numbered steps on that card are the fix. Fieldglass cannot ask Google on its own.

**A meeting is there, but the objective you typed is gone.**

Type it again on Today under that meeting. An objective is kept across calendar refreshes for the same meeting. A meeting that was deleted and created again on the calendar is a new meeting, so the old objective does not move with it.

**You tapped the meeting card and nothing is listening.**

That is correct. The first tap only opens “Tell the room…”. Tap once more on that screen to start. Until the header shows `● LIVE`, the mic is off.

**You are in a meeting and no hints appear.**

Check these in order:

1. The header shows `● LIVE`. If it shows `○ MIC OFF`, start again from the meeting card.
2. An empty screen is normal. Hints are rare on purpose.
3. Fieldglass does not hint on your own voice. If it has you and someone else swapped, long-press and choose **That was me**.
4. If the profile is Listening, you only get a hint for a concern or a recall. Long-press the meeting card before you start, and set Profile to Work for a working meeting.
5. If you marked the same kind of hint Off target three times, that kind stays quiet on this profile. It is still quiet if you come back to the same profile. Long-press the meeting card and pick a different profile (Work, Everyday, or Listening). The new profile has its own memory.
6. If you chose **Pause hints for 15 minutes**, wait 15 minutes or end the session and start a new one.
7. You will not get a hint that needs a speaker name when the glasses do not know who spoke.

**A hint is wrong.**

Tap it if the idea was right and you are done with it. Long-press and choose **Off target** if that kind of hint should stop.

**You need to stop now.**

Double-tap, then confirm. Or long-press and choose **End session**. Save any quote you want on the next screen. Double-tap when you are finished. The rest of the transcript is discarded. `○ MIC OFF` confirms that.

**Send did not post to Slack (or email, or Notion).**

Send does not post anywhere by itself. On Follow-ups, choose one of your existing HeadLenss sessions, then Send. On the glasses, approve the tool when Claude asks, the same as any other session. Until you approve, nothing is created.

**A follow-up disappeared.**

Unsent follow-ups are removed 7 days after you save them. Sent ones stay marked with the session you sent them to. If you deleted it on the phone, it is gone.

**You want Fieldglass data removed from the Mac.**

On the phone: Fieldglass → Privacy → **Delete all Fieldglass data**. Your sessions and the speech key stay. The next calendar refresh can fill Today again. Quotes you did not save were never on the Mac.

**The words on the glasses froze mid-meeting.**

End the session if `● LIVE` is gone, then start again from the meeting card (consent screen, then tap). Text from a session that already ended is not kept, and it is not sent anywhere. A hint is never delivered for you in the background after you leave.
