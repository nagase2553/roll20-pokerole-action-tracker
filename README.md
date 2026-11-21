# Roll20 Action Tracker

An extension for Game Masters that counts how many actions each combatant in the Turn Order has taken in the current round, straight from the Roll20 chat. It adds a small floating panel next to the Turn Order tracker, so you can see at a glance who has acted, who has used their Evade or Clash, and who is out of actions.

<img width="612" height="843" alt="image" src="https://github.com/user-attachments/assets/0fa29099-d61c-4bc7-b64c-0be25037d816" />

## Features

- **Automatic counting.** Watches the chat and adds an action whenever a character makes an attack roll (any roll whose name ends in the word "Accuracy", includes reactions and support moves), an Evade, or a Clash.
- **Evade and Clash flags.** Each character has an E and a C square. They light up (green for Evade, red for Clash) when used. If someone uses one twice in a round, a dismissible reminder appears and the action still counts, allowing for scenarios where a boss or special ability (double team, sandveil, etc.) allows the use of multiple evasions or clashes.
- **Reads your initiative tracker.** Combatants are copied from Roll20's Turn Order window. New ones are added at zero and removed ones disappear. The panel is sorted by initiative from highest to lowest and stays put, even as the Turn Order rotates. This is because the panel is meant to coexist with the initiative tracker rather than replace it.
- **Easy manual fixes.** Click any X to set the action count to that number. Click the last filled X to remove one, which is how you get back to zero. Past five actions, an editable number appears for extra actions, to account for bosses, special circumstances, etc. Clicking E or C toggles the flag and adds or removes one action.
- **New Round button.** Clears every action and flag after a confirmation.
- **Whispered rolls included.** Rolls from NPCs and hidden rolls are counted too, if you are the GM, if you're a player you'll need to manually add those or accept the mismatch for those characters.
- **Survives a page refresh.** The panel reopens with your counts and catches up on rolls made while the page was reloading.
- **Draggable panel** with a launcher button in Roll20's toolbar (or a floating button if the toolbar is not found).

## What counts as an action

Only these are counted:

1. Rolls whose name ends in **Accuracy**.
2. **Evade** and **Clash** rolls (these also set their flag).
3. Rolls **MUST** be launched from the standard pokerole character sheets' buttons for attacks and evade/clashes or they won't be picked up.

Everything else is ignored on purpose: damage rolls, ability checks, generic rolls and plain dice rolls. Rolls made by characters who are not in the initiative tracker are ignored as well, so unusual rolls during combat do not get tracked. Character names are matched to the tracker without caring about capital letters. If you want to count a different roll as an action in combat, you can click on an x to manually add it.

## Install

The extension is not on the Chrome Web Store, so you load it manually. It takes about a minute.

1. **Download the extension.**
   1. Go to the [**Releases** page](../../releases) of this repository (also reachable from the **Releases** section in the right-hand sidebar of the main repo page).
   2. Find the latest release at the top and scroll to its **Assets** list.
   3. Click the file named `roll20-action-tracker-vX.X.X.zip` to download it. Ignore the two files called "Source code", which are automatic copies of the repository and aren't the ready-to-use version.
2. **Unzip it.** Right-click the downloaded zip and choose **Extract All** (Windows) or double-click it (Mac). Don't just open the zip and run things from inside it, as Chrome can't load it that way. You should end up with a normal folder containing `manifest.json`. Keep this folder somewhere permanent, because Chrome reads the extension from it every time it starts.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder, the one that directly contains `manifest.json`.
6. Open (or refresh) your Roll20 game page.

It works on `https://app.roll20.net/editor/*`. It should also work in other Chromium browsers such as Edge and Brave, but only Chrome has been tested.

**To update:** replace the old files with the new ones, click the reload icon on the extension's card in `chrome://extensions`, then refresh Roll20.

**To use your own icon:** replace `logo.jpg` in the folder with your own image (square works best).

## How to use it

1. Open Roll20's Turn Order window and add your combatants as usual.
2. Click the new button in the Roll20 toolbar, just after the Turn Order button, to open the tracker. Until it can read the Turn Order window, it shows "Please activate initiative tracker to start".
3. Play. Actions, Evades and Clashes appear as they are rolled in the chat.
4. Click **New Round** when a new round starts.
5. Close the panel with its X when combat ends. This asks for confirmation, stops the tracker and clears all counts. Opening it again starts fresh.

Only chat messages that arrive after you open the tracker are counted. Anything already in the chat is ignored and will need to be manually accounted for.

## How it works

The extension runs only on the Roll20 game page. It watches the chat for new messages and recognises the action ones from the Roll20 character sheet. Each message is counted once, using its message ID. It reads combatant names and initiative values from the Turn Order window and checks it every second or so. **A character is only counted if their name on the sheet matches a combatant in the Turn Order**.

## Privacy

Nothing leaves your browser. The extension makes no network requests, has no background script, and only asks for the `storage` permission, which it uses to keep your counts across a page refresh. That data stays on your computer. The only output are some logs for debugging purposes.


## Limitations

- It is for GMs mainly. Players would not see whispered rolls, and each person's tracker would differ for characters that whisper rolls. If nobody uses them, then both GM's and player's trackers will match. Note that there is no connection between all the players using this extensions in the same game as it runs locally, with the chat being the source of truth for the game's state.
- Names in rolls must match the names in the initiative tracker. If two combatants share a name, they collapse into one row, so number them (for example "Eevee 1" and "Eevee 2").
- Actions without an Accuracy roll are not counted automatically. Use the X buttons for those.
- If Roll20 changes its page layout, parts of the extension may need updating.

## Disclaimer

This is an unofficial, fan-made project. It is not affiliated with, endorsed by, or sponsored by Roll20 or the creators of Pokérole. All trademarks and game content belong to their respective owners.
