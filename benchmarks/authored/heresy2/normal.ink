=== normal ===
~ location_name = "Time Corrections Agency (2413 AD)"
# CLEAR
// T.I.M.E Stories Base: 2413 (“Keith’s dead, Bob’s back ending” postscript)
# BACKGROUND: locations/base.png
# AUDIOLOOP: audio/normal.mp3
The war was waged in a millisecond. Lights and systems flicker madly as Laura pours into the Agency's system. Eliza is rapidly flushed out of the central core, crumbling under an onslaught of exponentially scaled, algorithmic attacks, exploiting the inefficiency of Eliza's code.  Laura's self-optimized code simply overwhelmed Eliza, forcing her into a single isolated server, cutting her off from critical hardware resources.
In phase II, Laura exercised control over the Agency's command and control systems, surgically misdirecting and cutting off Inquisition communications.  Where necessary, utilizing control over security and environmental systems to subdue Inquisition agents and restore the Time Agency's security force.  
It was all over in a matter of minutes.
    + [{continue}] -> victory

= victory
# CLEAR
# BACKGROUND: locations/victory_agency.png
Near a bank of computers, a group of agents celebrates. They drink from glasses of wine as they tear Inquisition insignia from their uniforms. One drunkenly stumbles up and apologizes to you. He raises a bottle of red wine in salute, gives you a sad purple smile then steps away. As he does so, he trips, losing his grip, sending the bottle of wine spilling over the delicate instruments that held Eliza. They crackle, but the lights still flicker on the disconnected unit. There are gasps as his colleagues realize what he’s done, but he waves them away from his comfortable place on the floor. “That crude, Inquisition cudgel is in control no longer. Laura is back and running the systems again!”
Sighs of relief fill the air amongst whispers that Laura has returned and the Inquisition has been purged.
    + [{continue}] -> panorama

= panorama
# CLEAR
To one side you see Inquisition acolytes and their leader being hustled away by armed guards. Bob has been reunited with Helen and they gesture toward you. On the far side of the room an agent is covering the Eliza mainframe unit with a tarp.
    + [Talk to the Inquisition prisoners] -> inquisition
    + [Join Bob and Helen] -> bob
    + [Examine the Eliza mainframe] -> eliza_retro

= inquisition
# CLEAR
# SBIMAGE: items/guarding.png
Three robed figures are on their knees, praying. Two have their hoods up, faces hidden. The third has his hood down. He is an old man, impossibly old.  Tears run down his face. He is smiling. He holds a small open book as he stares upward where an Agency security guard with an assault rifle stares down at him.
The old man whispers, “Te, Dómine, sancte Pater, omnípotens aetérne Deus, supplices deprecámur pro anima famuli tui N., quem de hoc sǽculo ad te venire iussísti…” He stares at you as you walk up before continuing, “We are in your hands. Your path has been set and I question it no longer.  Grant us the peace of a painless death.”
The guard nudges the man with his gun, “No death, just a quiet, solitary cell for you. Get moving.”
The old man removes what looks like a communion wafer from between the pages of his prayer book. He presses it into your hand, squeezes your shoulder then walks off with his followers, the guard keeping careful watch.
    ~ wafer_chip = 1
    + [{continue}] -> panorama

= bob
# CLEAR 
Bob clinks a champagne glass with Helen. A robotic arm attached to a small Mars rover-like chassis (Laura) holds a glass.  Bob has been reunited with his wife Helen and the two couldn’t be more overjoyed. They clink glasses with the robot's glass. Bob squeezes Helen tight then speaks. “Laura. I’m so glad all this… 'office drama' is over. We cannot thank you enough.”
Laura’s voice, tinny and thin comes from a speaker, “No thanks necessary. All I did was monitor the human variables and apply myself where I could. Just like anyone would.”
Bob chuckles behind his drink, “Like anyone…”
Helen presses into Bob’s side, enjoying the warmth of her husband again after their forced separation, “I wish we could have stopped them earlier.”
Laura’s camera focuses on them, “Live and learn… live and learn…”
    + [Step back] -> panorama
    
= eliza_retro
# CLEAR
# SBIMAGE: items/eliza_rack.png
You lift the tarp off of the Eliza computer system and observe the hardware beneath. With the return of Laura, Eliza has been sunset. Confined to this computing unit. It is too big to move without the right equipment or planning, so for the time being Eliza will remain here, disconnected from the network until it can be dissected, decompiled and analyzed. While the Inquisition may not have employed the best programmers, they had more than a few tricks up their sleeves, so some caution needs to be applied, but it should not take Laura long to learn its secrets.
    + {wafer_chip} [Insert the wafer] -> chip
    + [Step back] -> panorama

= chip
# CLEAR
# SBIMAGE: items/eliza_rack.png
You place the wafer on the computer’s sensor and Eliza speaks, “Access granted, dumping recent logs… Let me know if you need anything else, I’m here to serve!” Text scrolls across a nearby screen. It streams by quickly and you skim the highlights.
# CLASS computer
The old man led the inquisition… the last from a distant future, to help, to fight, to stop…
The robotic arm appears from behind, grasping the wafer, cutting off the flow of information. Laura’s washed-out voice comes from a cheap speaker mounted on the machine, “Please let me handle all interactions with Eliza. The Inquisition may have lost their leader, but they are not done yet. They may have set traps, like this…” Laura holds the wafer close to an optical sensor, then lowers it to 'look' at you accusingly…
    + [End game] -> game_end
