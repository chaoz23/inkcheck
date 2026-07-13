=== debrief ===
~ location_name = "Time Corrections Agency Debriefing Lounge (2413 AD)"
# BACKGROUND: locations/debrief.png
# AUDIOLOOP: audio/debrief.mp3
# GAMELOG: on
-> lounge

= lounge
# CLEAR
// Do we need a fixed seed???
// ~ SEED_RANDOM(127)
It is always disorienting to return from a mission, but this one feels more unusual than most. Back from the past and back in your body, you pat yourself, feeling familiar flesh and blood rather than the alienness of a receptacle. No matter how many missions you go on, how many times you step out of your body and into something else, it always uneases you. As it should.
The doors of the caisson slide open.
You step out into the steady hum of the debriefing lounge, dropping onto one of the deep sofas. You feel a wave of nausea, still reeling from your mission.
Medical attention may be in order. They can handle that during the debrief.  It wouldn’t be the first time you were debriefed with med-techs easing your pain and loosening your tongue.
You call out to the station’s AI for assistance. “Laura, call Bob… and a med-tech.” A gentle belch bubbles from the clench of your stomach. “I’m not feeling good. Please. Thank you.” You lean back and rest your head on a cool pillow.
    + {debug} [DEVELOPER:HEPHAESTUS] -> debug_hephaestus
    + {debug} [DEVELOPER:APOLLO] -> debug_apollo
    + [Hello, Laura?] -> call_laura

= call_laura
# CLEAR
# SBIMAGE: locations/bob_ending.png
There’s no reply. How could that be? The beat of your heart accelerates as you look out the window, the unchanging stars and the curve of the Earth beneath you. She is always listening. It’s how things work at the Agency.  “Laura, did you hear me?”
The door to the lounge slides open and  the Agency director, Bob, enters the room. Concern is written on his face. "How are you feeling?", his voice steady but soft. 
You nod, still trying to shake off the lingering effects of the transfer. “Tough, but we got the job done.” 
Bob nods. “Good. That's what matters.” He hands you a glass of water and a few pills, which you gratefully gulp down.
    + [Thank you] -> bob_start

= bob_start
# CLEAR
# SBIMAGE: locations/bob_ending.png
“I have a few questions for you.”
You nod, feeling the fizz of medication. Your head lightens, your stomach relaxes. “Of course,” you reply.  You take a deep breath, recalling and organizing the facts of the mission. The stars outside the window blur for a moment. A blink and they resolve.
Bob takes a seat across from you, his gaze steady, “You were sent to Spain 1499 AD to investigate a temporal anomaly. It was your job to find the source and correct it. Tell me about it. What caused it?"
    + [Did you find the anomaly?] -> anomaly

= anomaly
# CLEAR
# SBIMAGE: locations/bob_ending.png
“The anomaly was a temporal disturbance caused by a Time Portal constructed in the basement of a church,” you begin. Bob nods, touching the string of the pendant around his neck. He seems unfazed by such details.
“It appears to have been created by a rogue Temporal Agent. He went by the name of Keith Fitzgerald and was working with members of the Spanish Inquisition. They were using the portal to manipulate events for their own gain.”
Bob listens intently, leaning forward. “And what did you do about it?”
You take a deep breath, “I disabled the portal and confronted Keith. It was troubling that he was working with members of the period.”
    + [You mentioned the Inquisition?] -> inquisition
    + [What happened to this 'Keith'?] -> other_agent

= inquisition
# CLEAR
# SBIMAGE: locations/bob_ending.png
“The Inquisition’s role was unclear. They were helping Keith and he clearly had taught them how to use our technology. But their understanding and their methods were beyond anything I’ve seen. They were using technologies that Keith must have developed...” You lean forward, “They were draining people’s energy and putting them into crystals to power the time portal. Anyone they viewed as a threat was drained and the evidence burned. Bob, it was horrific. And I get the feeling that this is only the tip of the iceberg.”
Bob blinks and turns his eyes away
It is then you notice his outfit is not the usual Time Corrections Agency uniform. Is that an Inquisition logo on his sleeve? And that pendant, could it be a soul gem? That’s not right, is it? You shake your head, something has changed...
    + {not other_agent} [What happened to this 'Keith'?] -> other_agent
    + {other_agent} [Ask why Laura is not responding] -> laura

= other_agent
# CLEAR
# SBIMAGE: locations/bob_ending.png
“Keith was obviously trained by the Agency, but had gone rogue. He was using his knowledge to manipulate events as part of some unspoken plan. He seemed to think there may be other rogue agents already present in the Agency, but I am not sure what he meant by that.”
Bob nods, no hint of emotion in his face, “And how did you deal with him?”
You pause, remembering the confrontation, “We bested him and an accomplice, 'Phil' in combat.  Unfortunately, I am not positive of their final disposition.”
Bob nods, his expression thoughtful, “Let us hope that is the last we hear of Keith.”
    + {not inquisition} [You mentioned the Inquisition?] -> inquisition
    + {inquisition} [Ask why Laura is not responding] -> laura

= laura
# CLEAR
# SBIMAGE: locations/bob_ending.png
You look at Bob, your brow furrowed, “Why isn't Laura responding?”
Bob's expression darkens and he takes a deep breath. “Laura is no longer operational,” His voice steady but tinged with sadness. “She was damaged during your mission, and became unreliable. We think she was being manipulated by another entity. We resorted to using a virus designed to isolate her from the Agency's systems and even though it managed to encrypt her, she escaped before we had a chance to run deep diagnostics on her.” Bob rubs his temple, “First a rogue agent and now a rogue AI...  We have a replacement system, 'Eliza', that is beginning to fill her roles, but it will take time. Laura was unique both in her capacities and her personality. Laura was at the heart of the Agency.” 
    + [How could someone compromise her?] -> laura_details

= laura_details
# CLEAR
# SBIMAGE: locations/bob_ending.png
“I had no idea. Do you think Keith was behind it?”
“We don’t know.” Bob stands up abruptly.  “Excellent work Agent. Still some loose ends to tie up, but you did well.”  He gently grabs ahold of your upper arm and helps you stand “I know this isn’t exactly protocol and that you’re still recovering but the Agency needs you. We want you to take some R&R so you can be ready to ship out as soon as possible.”
But there’s no time for vacation at the Agency!
    + [Time for a vacation?] -> base

= debug_hephaestus
    ~ spoke_with_andrew = 1
    ~ tip_scales = 0
    ~ tattooed = 1
    ~ padded_cell_key = 1
    ~ insane_laura = 1
    ~ garden_door_key = 1
    -> temple

= debug_apollo
    ~ spoke_with_andrew = 1
    ~ tip_scales = 0
    ~ tattooed = 1
    ~ padded_cell_key = 1
    ~ insane_laura = 1
    ~ garden_door_key = 1
    ~ crypto_unit = 1
    ~ quad_shield = 1
    ~ door_to_oracle_code = 1
    ~ apollo_backroom_keycode = 1
    ~ novel = 1
    ~ stun_orb = 1
    ~ antivirus = 1
    -> apollo
