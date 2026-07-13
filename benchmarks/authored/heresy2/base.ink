=== base ===
~ location_name = "Time Corrections Agency Caissons (2413 AD)"
# BACKGROUND: locations/base.png
# AUDIOLOOP: audio/base.mp3
-> card_B

= card_B
# CLEAR
# SBIMAGE: locations/bob_ending.png
Bob escorts you towards the caissons as you begin to question him about the situation. He holds up a finger as he hurries along, as though he knew what you were going to ask, “There will be plenty of time for questions, after you get some much deserved rest. Eliza, the door please.”
The doors of the caisson swing open at his request. He grasps your shoulder and gently pushes you in. Disoriented and drained, there’s little you can do to resist.
Bob makes you comfortable then activates the restraint system. Restraints? Was this part of protocol? “Taking care of Keith has opened some new doors. Strange doors. And well...”, he doesn’t look at you. “The higher ups thought you deserve time off...  while we see what’s behind them.” 
The lighting is too bright in here, the air too stale. Only the constellations outside the window remain the same.
    * [{continue}] -> card_C
    
= card_C
# CLEAR
# ELIZA
# SBIMAGE: locations/base_tube.png
Bob steps back, a sad smile on his face but not in his eyes. “We’re sending you back to ancient Greece for a little R&R. You remember the little facility we run there?” 
“The detention center?” you counter.
Bob smiles, “Does a prison have good wine and beautiful beaches? Eliza will fill you in.”
Bob presses the button to start the time transfer. He looms above, while the doors of the caisson slide shut narrowing your view. The world is consumed by darkness until only Bob’s distant, hollow eyes remain. Then the doors snap shut with a hermetic hiss. Bob is gone and darkness is everywhere.
    * [{continue}] -> card_E
    
= card_E
# CLEAR
# AUDIOLOOP: audio/alarm.mp3
In the black of the chamber, a light appears, rushing towards you. Videos of lush olive groves, bustling city centers, and craftspeople plying their trade fill your view and your senses. Great temples tower above, and by the sea, vacationers lounge with their cups, soothed by the sound of wine-dark waves. Beautiful music fills your ears and wonder fills your mind.
Eliza begins to speak, her voice protocols primitive and rough compared to Laura.
# CLASS: computer
“Welcome vacationer! You have earned… an unspecified amount of time …in the Greek paradise of Athens, year 450 BC. Your mission: enjoy yourself!”
    * [{continue}] -> workshop.transfer
