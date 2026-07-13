/*
 * These are the globally addressable state variables.
 * Having these variables in the global space makes
 * them easier to access from the web page Javascript.
 * For example:
 *
 * story.variablesState["varname"]
 *
 * can be used to access the current VAR values defined here.
 *
 * One other note, the language supports the use of general
 * tags in comment lines:
 *
 * Pre-defined tags:
 *  # BACKGROUND: src
 *  # IMAGE: src     - an inline image
 *  # SBIMAGE: src   - a sidebar image
 *  # LINK: url
 *  # LINKOPEN: url
 *  # CLASS: classname  - text should use a specific css class
 *  # CLEAR
 *  # RESTART
 *  # AUDIOLOOP: src  - background audio
 *  # AUDIO: src      - one-shot audio
 *
 *  # IMAGEHEIGHT: height - the height of the next IMAGE (preserves aspect ratio)
 *  
 *  # COMBO: var_name - insert an instance of the combo lock - combo_symbols and combo_value interface to this
 *           var_name is a variable that holds the correct combo, currently only used in 'debug' runs
 *  # COMBO_DONE: pass|fail|disable - used to indicate that the combo lock has been solved or failed. 
 *           The buttons are disabled. 
 *
 *  # HTML: text  - insert the text verbatim into the HTML stream.  Note: use '<ss>'' for '//'
 *
 * see main.js for how these are handled.  However, any other
 * tags are legal as well (e.g. # HELLO: foobar) and the "step"
 * function in main.js can detect and respond to these while
 * generating the HTML blocks.
 *
 * Codes in the text:
 *    'HTML' is replaced by the HTML: 'text'
 *    'GLYPHx' is replaced by the code for x where x = [0,9]
 *
 * Useful links to the ink language:
 *
 * https://github.com/sawradip/ink-cheat-sheet
 * https://docs.unfold.studio/user_guide/ink.html#part-5-advanced-state-tracking
 * https://github.com/inkle/ink/blob/master/Documentation/WritingWithInk.md
 *
 */

// the "next" text
VAR continue = "Proceed..."

// The name of the current "location" (usually set in the knot)
VAR location_name = ""

// The power cost of moving from one location to another
VAR location_change_cost = -1

// is non-zero if the path to the temple has been found
VAR temple_found = 0

// is non-zero if you stole the crutch at the temple
VAR stole_crutch = 0

// is non-zero if you spoke with the servant in the garden (who "vouches" for you).
VAR spoke_with_andrew = 0

// is non-zero if you won the fight in the temple cella
VAR won_cella_fight = 0

// if non-zero, Laura has pointed out the scales
VAR tip_scales = 0

// if non-zero you have bested the philosopher
VAR philosopher_win = 0

// if non-zero, apollo and daphne have become a statue
VAR apollo_and_daphne = 0

// State of marble workshop lockpicking 0=none, 1=failed, 2=worked
VAR lockpick_table = 0

// if laura is owl and encrypted = 0, laura is owl but unencrypted = 1, has spoken to keith = 2
VAR laura_state = 0

// If bob apologizes for sending you to Athens, this will be non-zero
VAR bob_has_apologized = 0

// The state of the workers in the hypermarket apparel section
// 0=not met, 1=bribed and have left, 2=unconscious not drained, 3=unconscious drained
VAR apparel_workers = 0

// if keith trusts you, this will be non-zero
VAR keith_trusts = 0

// variables used by combat() tunnel.  Set these first and call combat() to
// run a round of "combat"
VAR combat_health = 0.
VAR combat_attack = 0.
VAR combat_defense = 50.
// damage = attack*(ratio/(ratio+defense))
VAR combat_ratio = 100.

// variable used by the "combination lock" (# COMBO)
// This variable contains the initial state and
// the GUI sets story.variablesState.combo_value
// to the current combination state.
VAR combo_value = 0
// If set to 1, use the set of symbols rather than numbers
VAR combo_symbols = 0

// These are all the combinations used in the story. Storing them in JS accessible 
// variables allows for randomization of the combinations or access from JS by name
// for 'debug' runs.

// Access to Melampus in the Temple of Hephaestus
VAR code_melampus = 1337

// Access to apollo_backroom from apollo foyer
VAR code_apollo_backroom = 9232

// Access to apollo foyer in the Mausoleum Workshop
VAR code_apollo_foyer = 7154

// Access to fridge (time portal) in the HyperMarket Deli section
// GLYPH6 GLYPH0 GLYPH2 GLYPH8
VAR code_deli_fridge = 6028

// Impossible computer code for the workshop computer
VAR code_workshop_computer = 10000

// This is used when we need a cash check w/o an item in play. 
VAR dummy_item = 0

// debug can be set to any value via '?dev=x'
// This enables shortcuts {debug} that speed development
VAR debug = 0
