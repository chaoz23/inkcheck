=== agora ===
~ location_name = "The Agora"
# BACKGROUND: locations/agora.png
# AUDIOLOOP: audio/agora.mp3
-> power_change( location_change_cost ) ->
-> panorama

= panorama
# CLEAR
The center of the city, the agora, is usually well cared for and ornately decorated. But the agora of Athens has seen better days. A long stoa stretches out before you, begrimed with dirt and soot from cooking meat. Multiple shady merchants have setup shop and on the margins, dark alleys loom.
There is a rather shady looking market place.  Guarded, side glances dominate this market. Food options include an inexpensive food counter and higher-end restaurants. A dark alley fills the gap between the eating establishments and an ironmongers.
    + [Visit the shady market] -> black_market
    + [Walk up to the food counter] -> fast_food
    + [Approach the fancy restaurant] -> restaurant
    + [Amble down the alley] -> alley
    + [Pay a visit to the ironmongers] -> hardware
    + [Continue down the main street to the Pnyx forum] -> pnyx
    + [Take the southern walkway to Phidias' workshop] -> marble_workshop
    + [Return to the Temple of Hephaestus] -> temple

= black_market
# CLEAR
You approach the stall hoping to find some useful tools for the work ahead. A merchant smiles broadly at you and his tongue flicks behind a broken wall of teeth. He moves a filthy cloth to uncover a series of gadgets that hum in your mind with strange music.
{crutch and stole_crutch:
He notices Aspasia's crutch and turns away from you, “I have nothing to sell to someone of your nature!”
    + [Return to the street] -> panorama
- else:
“Everything is for sale,” he purrs. “If you are willing and able to pay the price…”
    + {not crypto_unit} [Quantum Crypto Unit: 2 Drachm] -> buy_crypto
    + {not quad_shield} [Quadiken Shield: 3 Drachm] -> buy_shield
    + {crypto_unit and quad_shield} [Sorry, my stock is completely depleted at the moment.] -> panorama
    + {not (crypto_unit and quad_shield)} [Return to the street] -> panorama
}

= buy_shield
    -> buy_something(3, quad_shield) ->
    {quad_shield: One Quadiken Shield it is!}
    + [{continue}] -> black_market

= buy_crypto
    -> buy_something(2, crypto_unit) ->
    {crypto_unit: One Quantum Crypto Unit it is!}
    + [{continue}] -> black_market

= fast_food
# CLEAR
{ not tip_scales:
# SBIMAGE: items/scales.jpg
A marble counter serves food to those of the lower caste in Athens and Inquisition detainees like you. The kitchen is strikingly modern behind the counter with its own oven. Agency and Inquisition technology are subtly integrated into the traditional Greek kitchen, further evidence the Inquisition is at least influencing the Agency.
A cook behind the counter shouts and sweats as he slings bread, olives and bowls of lentils.  He calls out to you, encouraging you to step forward. As you move forward to see what wares he has for sale, the owl swoops forward and lands atop a set of scales GLYPH2, gesticulating and making eye contact with you. 
As one arm drops, the other rises, and the owl adjusts to keep balance, but something is off. The cook tries to shoo the bird away, but the owl flaps its wings and shifts its mass, tipping over the scales and sending a hidden stack of three coins he was using to bias the scale to the ground. The chef curses and rights the empty scales. 
Everyone in line notices the scales were rigged. The crowd confronts the cook, demanding to know what he has to say for himself. In the confusion, you see a chance to grab the coins and exit the establishment. The owl clicks a guttural sound as though laughing before it flies above the gathering crowd.  
    ~ tip_scales = 1
    -> cash_change(3) ->
    + [{continue}] -> panorama
- else:
There’s a crush of people at the counter, nearly all of them bearing the same tattoo as you.  The cook however displays the symbol of the Inquisition sewn crudely to his apron.  By the time you make it to the front, there is little left. The cook swats at flies hovering over the last dregs of fish and barley loves during his free moments.
As before, the owl is attracted to the scales. It lands on them, stamping and squawking to get your attention, but this time it does not tip them over. 
{not fava_beans:
    “Beans and kykeon,” says the cook, gesturing to a rough bowl. “Take it or leave it.” He wipes his nose into his apron then stares at you. “You heard what I said! Buy ‘em or go!” Seeing that you won’t discipline yourself, he reaches for a wooden spoon to strike you with.
        + [Buy fava beans (2 Drachm)] -> buy_beans
        + [Create a distraction] -> chaos
- else:
    “You've had your portion!” snarls the cook, pointing at your bowl of beans. “Next!”
}
    + [Leave the establishment] -> panorama
}

= buy_beans
    -> buy_something(2, fava_beans) ->
    {fava_beans: You are the proud owner of a bowl of fava beans!}
    + [{continue}] -> fast_food

= chaos
# CLEAR
You lean across the counter and barely reach a container of brining feta, tipping it onto the floor. The clay vessel shatters sending shards of clay awash in salty water into the corner of the room.  The cheese spills out with it, rolling across the floor. 
{ RANDOM(0,10) > 3:
    The cook yells in anger and rushes to clean up the mess, leaving his station unattended.
    + {not fava_beans} [Grab the beans] -> grab_beans
- else:
    The cook sees your game. He cracks you on the hand with a wooden spoon and spends quite a while telling you what a disappointment you are to everyone you know and everyone you don’t. He then throws a pitcher of dishwater your way and the resulting shock resonates though your suit.
# AUDIO: audio/shock.mp3
    -> power_change(-5) ->
}
    + [Leave the establishment] -> panorama

= grab_beans
    You take the opportunity to grab some beans.
    ~ fava_beans = 1
    + [Leave the cook to his mess] -> panorama

= restaurant
# CLEAR
A maître d' stands outside of a lavishly appointed restaurant, the bow tie with a toga is a bold fashion choice.
{beg > 2:
“You! again? You are not welcome here. I have told you before, no one wants to see you here.” The maître d' waves a velvet rope in your face and turns away.
- else:
As you try to enter, the maître d' clips a velvet rope to a stanchion by the door and stares with disdain at the symbol that marks you. “No entrance for the likes of you. Now leave before I call the guards.”
    + [Debase yourself and beg] -> beg
}

    + [Return to the street] -> panorama

= beg
# CLEAR
{crutch and stole_crutch:
“You have got to be kidding!  You steal Aspasia's crutch and then have the audacity to beg for more!?”, the maître d' scowls. “Begone!” You flee under a hail of blows.
- else:
    { RANDOM(0, 10) > 4:
    Why are you making a scene?! Fine, fine… take this and go away. Here is something you look like you could use.” He tosses you a recharge strip then turns to sunnily greet a couple who have arrived for their reservation.
    You plug the strip into an arm socket and your outlook improves a little.
        -> power_change(10) ->
    - else:
    The maître d' uncoils the velvet rope and proceeds to whip you with it. “Begone!” You flee under a hail of blows, with your pride being the only thing injured.
    }
}
    + [Return to the street] -> panorama

= alley
# CLEAR
Two columns frame the entrance to a dark space between two buildings. Even in the midday sun, this alley remains black as night, a pathway to an unknown place. It’s littered with shards of broken amphoras and the smell of drunken sickness. You pass the remains of a roasted chicken boiling with flies, round a corner into a cloud of ionized gas, and find a puddle of stale water rushing to meet you before all goes dark.
When you awake you find your purse lighter. A pile of rags and shadows laughs in the corner. “Plouton will have his due. You’re lucky you’re not alive. He would have taken that too!” The creature laughs a phlegmy laugh and turns on its side.
Perhaps it would be best to leave while you can.
    -> cash_change(-4) ->
    + [Return to the street] -> panorama

= hardware
# CLEAR
A cluttered shop loaded with gadgets and gizmos covering every inch of the small crowded shop. A woman sits behind the counter soldering wires from a power source to a mechanical hand.
As you enter, the proprietor finishes her work. The hand twitches and she looks up at you, pleased. She sees the mark of Keith on your shoulder and her eyes smile. “I’m not supposed to sell to your kind, but if some parts walked off, what could I do?” She returns to her work.
    + { not gold_wiring} [Discreetly grab a spool of gold wiring]
        ~ gold_wiring = 1
        -> panorama
    + [Return to the street] -> panorama
    