# theme: light

INCLUDE globals.ink
INCLUDE item_globals.ink
INCLUDE base.ink
INCLUDE workshop.ink
INCLUDE garden.ink
INCLUDE temple.ink
INCLUDE agora.ink
INCLUDE pnyx.ink
INCLUDE marble_workshop.ink
INCLUDE apollo.ink
INCLUDE apollo_backroom.ink
INCLUDE river.ink
INCLUDE hypermarket.ink
INCLUDE computerroom.ink
INCLUDE base_return.ink
INCLUDE control.ink
INCLUDE ascension.ink
INCLUDE normal.ink
INCLUDE debrief.ink
INCLUDE logging.ink

-> intro

=== intro ===
~ location_name = ""

# CLEAR
# BACKGROUND: locations/greece.png
# AUDIOLOOP:
# GAMELOG: off
# CLASS: head1
αίρεση II: Of what mettle Gods?
# CLASS: centered
Athens Greece, 450 BC - The age of Pericles
# CLASS: head2
Copyright © STORY_YEAR Randall Frank, Andrew Florance & Marina Galvagni
# CLASS: head2
Version: STORY_VERSION (STORY_BUILD_DATE)

    + [Begin the adventure] -> debrief
    + [Heresy I: background] -> background
    + [Attributions and thanks] -> thanks_to
    + [License] -> license
    + [Quit] -> outro


=== thanks_to ===
# CLEAR
# ATTRIBUTION
    + [Back] -> intro

=== license ===
# CLEAR
# HTML: <a target="_blank" href="https:<ss>github.com/randall-frank/heresy2-assets">Heresy II</a>
# CLASS: head2
HTML is released under a Creative Commons Attribution License.  
# CLASS: head2
Copyright © STORY_YEAR Randall Frank, Andrew Florance & Marina Galvagni
# HTML: <a target="_blank" href="http:<ss>creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International License</a>
The license allows people to use and adapt the work for any purpose, even commercially, as long as they give credit to the creators. Attribution must include the Title, Author, Source and License.  HTML is the complete text of the license agreement.
    + [Back] -> intro

// This tunnel is used to change the current power value up (+) or down (-)
// The value is capped [0,100] and if 0, the return will be redirected
// to the "end_game_power" game ending.
// Use it for combat, consuming batteries/recharge stations, etc
=== power_change(x)
    ~ exo_power += x
    { exo_power > 100:
        ~ exo_power = 100
    }
    { exo_power < 0:
        ~ exo_power = 0
    }
    { exo_power == 0:
        ->-> end_game_power
    }
    ->->


// This is used to buy an item.  It subtracts the cash and marks the item as being
// in your inventory.
=== buy_something(x, ref item)
    // Trap the case when one does not have enough money to buy something...
    { (cash - x) < 0:
        You do not have sufficient funds for this purchase. {marble_workshop.workspace: Perhaps a visit to the power exchange station in Phidias' workspace is in order?} {not marble_workshop.workspace: There have been rumors of a power exchange station in Phidias' workshop.  Perhaps you should check it out?}
        ->->
    }
    // Buy the item and add it to your inventory
    ~ item = 1
    ~ cash -= x
    ->->

// This tunnel is used to change the amount of cash one has.  There is a minimum, but no maximum
// Used for things like stealing, having money added to your account, etc.  
=== cash_change(x)
    ~ cash += x
    { cash < 0:
        ~ cash = 0
    }
    ->->

=== function check_melampus_list()
// oscillator - Pnyx orator necklace
// lcd_display - workshop sit at computer
// simple_battery - river take from Apollo/Daphne
// gold_wiring - take at agora
// convert into 'antivirus'
    { oscillator and lcd_display and simple_battery and gold_wiring:
        ~ return 1
    }
    ~ return 0

=== function already_have_a_garment()
// item_shorts
// item_poloshirt
// item_poloshirt_inquisition
// soulgem_empty
// soulgem_full
    { item_shorts or item_poloshirt or item_poloshirt_inquisition or soulgem_empty or soulgem_full:
        ~ return 1
    }
    ~ return 0

=== function seen_all_symbols()
// garden.dish
// temple.pronaos
// anthropoid_gear
// tip_scales
    { garden.dish and temple.pronaos and anthropoid_gear and tip_scales:
        ~ return 1
    }
    ~ return 0

// See norm.py for the derivation, but this function returns
// a floating point number from [0,100] with an approximate
// normal distribution.
// e.g. numbers around 50. have the highest probability.
// The approach was to compute the probability function
// and then fit that function to a 5th order polynomial
=== function rand_norm()
    ~ temp t = FLOAT(RANDOM(0,100))
    ~ temp f = 2.28564682
    ~ f = f + 0.776857910*t
    ~ f = f + 0.0590911716*t*t
    ~ f = f - 0.00219272853*t*t*t
    ~ f = f + 0.0000271392976*t*t*t*t
    ~ f = f - 0.000000109325083*t*t*t*t*t
    ~ return f

=== function attack_power()
// compute attack power (adjust based on items)
    ~ temp power = 20.
    { stun_orb:
        ~ power += 10.
    }
    { combat_training:
        // precision
        ~ power += 10.
    }
    ~ return power

=== function defense_power()
// compute defense power (adjust based on items)
    ~ temp power = 50.
    { quad_shield:
        ~ power += 20.
    }
    { combat_training:
        // agility/reflexes
        ~ power += 30.
    }
    ~ return power

// do a round of combat.
=== combat(opponent, ref success)
    You are locked in combat with {opponent} who is {combat_health>exo_power: stronger|weaker} than you.
    // Compute base damage as = attack*(ratio/(ratio+defense))
    // Then weight by a sample from a normal distribution
    ~ temp dmg_to_other = INT(FLOAT(attack_power())*FLOAT(combat_ratio)/FLOAT(combat_ratio+combat_defense))
    ~ dmg_to_other = INT(FLOAT(dmg_to_other)*(rand_norm()/100.0))
    ~ temp dmg_to_player = INT(FLOAT(combat_attack)*FLOAT(combat_ratio)/FLOAT(combat_ratio+defense_power()))
    ~ dmg_to_player = INT(FLOAT(dmg_to_player)*(rand_norm()/100.0))
    You do {dmg_to_other} damage while they do {dmg_to_player} to you.
    -> power_change(-dmg_to_player) ->
    ~ combat_health -= dmg_to_other
    { combat_health <= 0:
        ~ success = 1
    }
    ->->

=== give_up ===
# CLEAR
# AUDIO: audio/shock.mp3
~ location_name = ""
-> power_change( -50 ) ->
You open a compartment in the ZXT Mark V and use a metal probe to short the battery terminals.  Sparks and smoke are emitted in the process.
    + [Again...] -> give_up


=== end_game_power ===
# CLEAR
# SBIMAGE: locations/quit.png
The android shell ran out of power.  The fluidic body cools and solidifies resulting in a "marble" statue left in remembrance of your presence.  Your mind lives on, trapped in an inert vessel, entirely devoid of stimulation... for eternity.
    -> outro

=== background ===
# CLEAR
# HTML: <a target="_blank" href="https:<ss>github.com/randall-frank/heresy-assets">here</a>
This story is conceptually a continuation of the story from the Heresy T.I.M.E Stories fan written expansion.  That expansion can be downloaded and accessed HTML. The expansion can be downloaded, printed and played for free at any time.  A play-through is normally around 3-4 hours.  It is also available as a Tabletop Simulator expansion pack on Steam if you don't want to create physical cards.
If you are not in a position to play the original Heresy game, a basic overview of the key game point is available to bring you up to speed.  
Note: the background does include spoilers for the original game and we would strongly suggest one play that story first.  One other note, if you have played the original game, the spoilers might help jog your memory or point out some details that might have been unclear.
    + [Give me the (spoiler) background] -> spoilers
    + [I just want to play Heresy II]
        # RESTART
        -> intro


=== spoilers ===
# CLEAR
Ok, you asked for it...
The original game was written to be a T.I.M.E Stories expansion scenario.  You start at the base and are sent to stop a rogue agent named Keith who Bob asserts has constructed his own time portal somewhere in time and must be stopped.  Your team is sent to Spain 1499. 
The party is dropped directly into an Spanish Inquisition witch hunt and becomes the target of their investigation.  As you deal with them, you unearth the presence of a time portal that is being used to access a "box store" in the year 2015.  The Hypermarket is being used as a base and to provide supplies by Keith and his cohorts.  You eventually encounter Keith, leave him defeated and disable the time portal.
Along the way, you run into a number of Inquisition followers as well as Agency agents (like yourself and Keith). At some point, you come across a human arm sporting a tattoo of a star pattern (asterism) that factored into your investigation.
As you return to the base after 'successful' resolution of the case, you are thanked by Bob, but he seems... off?  He is wearing an unfamiliar uniform that has the logo of the Inquisition and includes a soul medallion of the type Keith used to power time portals.
Bob even goes so far as to suggest that you deserve a vacation...
Summary: It appears that Keith had been operating independently of the Inquisition, using their crusade to facilitate his work.  The purpose of which is not clear.  While his goals have been thwarted or at least delayed by your work, it is not clear that Keith was actually killed.  Likewise, the Inquisition have been using leverage over Bob to attempt to gain control over Keith's time portal and use it to further their own goals.  They have thus asserted control over aspects of T.I.M.E Agency itself, minimally through Bob, but perhaps other individuals.
    + [{continue}] -> background

=== game_end ===
# CLEAR
Fade to black... and with that you have reached the end of our story.  We certainly hope you enjoyed participating in the journey as much as we enjoyed building it.
    -> outro

=== outro ===
# AUDIOLOOP: audio/endgame.mp3
~ location_name = ""
# CLASS: end
Thank you for your consideration.
    -> END
