=== apollo ===
~ location_name = "Temple of Apollo"
# BACKGROUND: locations/apollo.jpg
# AUDIOLOOP: audio/delphi.mp3
-> power_change( location_change_cost ) ->
-> panorama

= panorama
# CLEAR
You find yourself high above Athens on Mount Parnassos. The great temple stands before you, pillars remind you of the classic epigrams: ΓΝΩΘΙ ΣEΑΥΤΟΝ, ΜΗΔΕΝ ΑΓΑΝ and ΕΓΓΥΑ, ΠΑΡΑ ΔΑΤΗ.
The doorway to the back of the temple entrance is flanked by a pair of sculptures, but appears closed to the public. The Pythia, current oracle and high priestess of the temple, and her attendant are taking a stroll under the watchful eyes of what appears to be an Inquisition guard.
Male and female statues bracket the temple façade.
    + [Examine the male statue] -> statue
    + [Walk up to the gate] -> gate
    + [Talk with the Pythia] -> pythia
    + [Examine the female statue] -> venus
    + [Return to the Mausoleum Workshop] -> transport

= transport
# AUDIO: audio/transport.mp3
Once again you step into the portal and are spirited back to the workshop.
    + [{continue}] -> workshop

= statue
# CLEAR
# SBIMAGE: locations/statue.png
A male statue reclines before you. From a distance, it appears to be another magnificent example of Phidias’ work, but there is more at play here.  Closer observation reveals you are mistaken. This is a Mark IV receptacle in powered down mode! From the arm tattoo, another detainee. {not sunbeam_plate: In the right hand of the supine receptacle you notice a unique plate bearing a sunbeam impression. Laura looks at the plate and cannot restrain her excitement, making sure you see it.  It would certainly warrant more detailed observation.}
    + {exo_power > 10 and sunbeam_plate == 0} [Transfer 10 power to the receptacle] -> powerup
    + [Return to entrance] -> panorama

= powerup
# CLEAR
# SBIMAGE: locations/statue.png
-> power_change( -10 ) ->
The android receptacle powers up in response to the power cell and the statue suddenly comes to life.  In a thick Russian accent, “What… where…  how long was I out…  What year is it?”  You answer, “452 BC?” He continues “10, no 12 years I’ve been out.  Спасибо!  A few more years and the emergency battery…  I don’t want to think about it.  That’s not the worst though, do you know how many times you can read Dostoyevsky???”
{sunbeam_plate: The black and gold plate sits beneath a sunbeam, its outside adorned, the inside blazing with golden light. The owl lands on its edge and stares into its silver depths. As though mesmerized, its head spins slowly round three times then blinks as though it cannot comprehend what it has seen. It flies off.}
    + {exo_power > 10} [Offer another 10 power for the plate] -> plate
    + [Return to entrance] -> panorama

= plate
# CLEAR
# SBIMAGE: locations/statue.png
-> power_change( -10 ) ->
“Ah, this old thing. It's obvious that someone understands its importance” he motions to the owl. “It is yours now.  Be careful with how you use it as you are likely to have only one shot at the game you are playing.  I (and many others) wish you luck!”
You pick up the plate and examine its design.  It is a highly polished silver plate with an complex, ornate border. Embossed at the center of the plate is a grid of symbols that look oddly familiar...
    ~ sunbeam_plate = 1
    + [Return to entrance] -> panorama

= gate
# CLEAR
# SBIMAGE: locations/gate.png
You walk up to the gate, looking for a way into the temple. You test the mettle of the gate…  Tritanium?  What is Tritanium doing in a Greek temple?  You haven’t the equipment, or time, to negotiate this obstacle right now.  You strain to see beyond the gate.  It looks like… desks and cubicles?  You make out the faint, but unmistakable hum of computing machinery in the background. A cryptic keypad appears to be connected to the gate.
{apollo_backroom:
    + [Enter the temple back room] -> apollo_backroom
- else:
    + {keypad} [Try the keypad] -> keypad
    + {not keypad} [Step up to the keypad] -> guard
}
    + [Return to entrance] -> panorama

= guard
# CLEAR
# SBIMAGE: locations/gate.png
A passing temple guard notices your interest and confronts you, “Hey, this area is off limits to you and your kind. You know the punishment!”  He reaches behind his back and brings out his quadiken and fires. 
{quad_shield:
    You are bathed in ionized plasma, but then... nothing?  Your quadiken shield disperses the plasma and to the guard's great surprise, you are not only unaffected, but you actually gain some power.
    You take the opportunity to strike him with a solid right to the jaw.  He drops immediately, knocked out.
    -> power_change( 10 ) ->
    + [Try the keypad] -> keypad
- else:
    As you are bathed in the ionized plasma, you feel the inescapable effects of the Inquisition “corrective” measure.
    -> power_change( -10 ) ->
    You need protection from the guard's quadiken.  Such a mechanism might be available from the black market.
    + [{continue}] -> gate
}

= keypad
# CLEAR
# SBIMAGE: locations/gate.png
With the guard subdued, you may try to enter the correct combination.
~ combo_symbols = 1
~ combo_value = 0
# COMBO: code_apollo_backroom
    + [Try the combination]
        { combo_value == code_apollo_backroom:
# AUDIO: audio/positive.mp3
# COMBO_DONE: pass
            The gate swings opens.
            + [Enter the back room] -> apollo_backroom
        - else:
# AUDIO: audio/error.mp3
# COMBO_DONE: fail
            The keypad sizzles, draining some of your energy.
            -> power_change( -2 ) ->
            + [Try again] -> keypad
        }
    + [Return to entrance] -> panorama

= pythia
# CLEAR
# SBIMAGE: locations/pythia.png
The attendant intercepts your approach, “My mistress has had a most busy day and is still recovering from her last vision and is still recovering from the effects of her trance.  Please consider coming by again tomorrow?”   She notices your tattoos, “On reconsideration, why are you here at all?  Your kind are certainly not welcome here!” She gestures to the “sculptures”, “We know how to deal with your kind!” and begins to beckon the guard…
The Pythia steps up and waves the guard away, laughing, “Ah, Eutropia, let them be.  They will be leaving soon, correct?” With a most malevolent grin, “In fact, I feel like having a little fun and I still have some power left, so let us gaze into the future a bit and see what our interloping friends have coming, shall we?”
She quickly takes your hand in a surprisingly strong grip, throws her head back and enters a trance.  “Hmm, your future is the future?  Spirits moving in time…  conflict, resolution, undoing, travel amongst the stars…”  With shocking celerity she snaps out of the trace, drops your hand and stares, wide-eyed into your eyes.  “You… you are the agent of change.  You will face a terrible decision of far reaching consequence for all of us. The very future of our past is within your reach, potential destruction and new vistas for mankind…”  She slumps to the ground and her attendant rushes to her aid. “Be gone from us, please take your leave. I will not answer any more questions today!”.
    + [Return to entrance] -> panorama

= venus
# CLEAR
# SBIMAGE: locations/venus.png
A second statue graces the far side of the temple entrance.  This one is in considerably poorer shape than the other one. The arms of the female form have been cruelly detached from the otherwise pristine form and lay as rubble at the foot of the statue. You note the ubiquitous detainee tattoo on a fragment of the arms. Recognition of the situation slowly filters into your consciousness…  an agent receptacle!   An older model, Mark II maybe Mark III?  Those models lacked the emergency power source, key to the preservation of the agent inside.  This poor soul, blinked out of existence after a power failure?  Accident?  Incident?  A body at the agency left forever without its human presence… A chance every agent takes, but an end is still an end.
# TODO Merkaba Driver - Not sure what to do here...
# You may undertake an engineering challenge to try to collect technology from the rubble.  On success, take: Item: Merkaba Driver - a very TIME Stories option - adjust abilities
# Maybe just a pickup to enhance attack and defense???
    + {exo_power > 2 and combat_training == 0} [Run a diagnostic on the receptacle (2 power)]
        -> power_change( -2 ) ->
        -> diagnostic
    + [Return to entrance] -> panorama

= diagnostic
# CLEAR
# SBIMAGE: locations/venus.png
// ご冥福をお祈り申し上げます = (gomeifuku o oinori moushiagemasu), which translates to "May their soul rest in peace
T.I.M.E Corrections Agency agent Murata Sumiko. Last assignment was to investigate rumours of time displacement equipment being used by elements of the Spanish Inquisition, an entirely unauthorized timeline. On return from assignment, disciplinary action was taken (no reason given) and she was exiled to this temporal location for 'supervision and re-education'.  An old Mark II suit outfitted for hard labor/combat.  Unfortunately, the suit lacked emergency 'cold storage' for the preservation of the occupant (illegal by today's standards). Any notion of Murata Sumiko perished in that suit when it ran out of power. “ご冥福をお祈り申し上げます”, you whisper.
{not combat_training: A further diagnostic reveals the combat training algorithm is compatible with the Mark V.}
    + {exo_power > 2 and combat_training == 0} [Upload the training algorithm (2 power)]
        -> power_change( -2 ) ->
        ~ combat_training = 1
        -> diagnostic
    + [Return to entrance] -> panorama
