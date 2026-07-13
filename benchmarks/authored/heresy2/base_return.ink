=== base_return ===
~ location_name = "Time Corrections Agency (2413 AD)"
# BACKGROUND: locations/base.png
-> power_change( location_change_cost ) ->
-> base_start

= base_start
# CLEAR
# AUDIOLOOP: audio/base.mp3
A white flash followed by pain and the darkness of a caisson. Your head throbs as the doors slowly slide open. You’re back in your body, back in the T.I.M.E Corrections Agency headquarters. The restraints holding your body let go all at once and you barely catch yourself from falling to the floor.
A man steps forward from another pod. He stares first at his hand and then at you with a wry smile. Could it be Keith? Or is he called Jordan? Does it matter? He nods at you as Bob and an Inquisitor in a hooded robe step up to greet the two of you. As expected, Inquisition members arrived before you.
Bob begins to speak but you cut him off quickly, before he can verbalize any questions, “Agent (Jordan) Hastings and I, reporting back from the Malta 1989 AD mission. The source of the temporal anomaly report turned out to be a residual temporal echo of a later mission.” Bob looks confused but doesn’t speak as you continue, “We can consider the matter closed.” You rub your head, “Please lead us to the debriefing before we lose the details.”
Bob’s eye twitches, “Yes, debriefing… please follow me.” “Inquisitor, if you will excuse us for a few minutes…”
    + [{continue}] -> laura_transport

= laura_transport
# CLEAR
# AUDIO: audio/transport.mp3
# SBIMAGE: items/laura_tube.png
Before you can move, a klaxon sounds announcing the arrival of another 'agent'. The portal activates a second time and an android body sometimes used by Laura on missions convulses to life, but the caisson doors do not open. Laura has been reunited with her android body, locked in caisson 7. 
“What is this?” the inquisitor snaps. The caisson’s scans of the android’s cognitive center show there is no human intelligence inside. “Her! It’s her!” He gestures to his acolytes, “Get the control device attached immediately!” He storms to a terminal and types frantically, trying to decipher what he is seeing.
Professor Hastings takes advantage and jumps into a nearby chair the Agency uses to facilitate pre-transport scanning. He begins to modify the chair and associated caissons, ignoring you, Bob, and the Inquisitor.
    + [{continue}] -> panorama

= panorama
# CLEAR
The air is thick as the Inquisition acolytes desperately try to attach a device to Laura's caisson.  Professor Hastings is eagerly working at a computer terminal. The Inquisitor is barking orders to his acolytes while he monitors their progress from behind a console.  Bob stands nearby, frozen with shock as the core of his Agency erupts into chaos.
    + [Talk to Bob] -> bob
    + [Talk to Professor Hastings] -> prof
    + {not subdue} [Confront the Inquisitor]
        {leader:
            -> leader_part_two
        - else:
            -> leader
        }
    + [Interact with the Inquisition acolytes] -> acolytes

= bob
# CLEAR
# SBIMAGE: locations/bob_ending.png
{not bob_helen:
    Bob is a man on the edge. He wrings his hands, torn between his loyalty to the Agency and his fear of the Inquisition.
- else:
    Anger flashes across Bob’s face. “I’ll get the security teams and we’ll deal with the Inquisition.” {not inquisition_leader_badge: “Confront the Inquisitor. Deal with him and his acolytes will fall into line…”}
}
{not bob_has_apologized:
    He slowly lifts his head to meet your gaze. “I thought the inquisition captured you. For a moment I thought the Inquisitor recognized you and Dr Hastings, but Laura’s arrival must have distracted him.” Bob touches your shoulder, “I don’t know how you escaped, but I apologize for sending you to Athens. I did not want to put you in danger, but they threatened Helen. I'm sorry.”
}
    ~ bob_has_apologized = 1
    * [Talk about Helen] -> bob_helen
    * [Talk about Laura] -> bob_laura
    + [Step back] -> panorama

= bob_laura
# CLEAR
# SBIMAGE: locations/bob_ending.png
“The Inquisition is a threat, but what of Laura?  Dr. Hastings seems to believe she is the solution to all of this. Can he, can they be trusted?”
Bob hesitates before answering, “Laura is an advanced AI, but we trained her core logic around supporting the Agency. I do not think she would harm us intentionally, but the Inquisition seems to think otherwise. They’re convinced she’s the first step in an existential threat to humanity. Agent, they don’t want to control her, they want to destroy her.”
“But what about Dr Hastings?  He seems to be working on something related to evolutionary changes in Laura. He doesn’t trust the Agency. Can we trust him?”
“Dr. Hastings has been critical of the Agency for a long time, but I always thought he was just being a contrarian. I never considered how far he might go. From his writings I think he believes that AI hybridization is key to unlocking mysteries of time and the universe.” Bob clenches his hands. “I honestly do not know what to do. I am not sure we should explore that path without proper safeguards.”
    +  [{continue}] -> bob

= bob_helen
# CLEAR
# SBIMAGE: locations/bob_ending.png
You whisper to Bob “The Inquisition is holding Helen in the facility in Athens, 450 BC. In one of the cells at the arrival mausoleum.”
The blood drains from his face. “She’s alive?”
“She is. Her consciousness is trapped in an android body there. Unfortunately we do not know where her physical body is being kept…”
A look of hope passes across his face. “I know where her body is…”  He leans in and speaks quietly, “I’ve been trying to locate her receptacle but the Inquisition has been watching me closely. I can’t just walk in there and rescue her.  If you can get her out, I will do whatever it takes to help you.”
{workshop.talk_with_helen: 
    You tell Bob that Helen told you about Europa and to not give up hope. His face steels and he reaches into his pocket, producing an Inquisition leadership badge. “I think you can use this. They wanted me to join the order. That will never happen now.”
    ~ inquisition_leader_badge = 1
}
    + [Thank you Bob!] -> bob

= leader
# CLEAR
# SBIMAGE: items/inquisitor.png
The Inquisitor traces a line on the terminal with his finger as you approach.  He barks orders to his acolytes, “Get the device attached quickly!  We are running out of time. She is a threat to the very fabric of our reality and must be isolated!”  
He looks up. An odd feeling of déjà vu washes over you. There’s something in his manner of moving and speaking…  Different body, different face, but your training identifies similar patterns and mannerisms. 
He smirks, “Yes, it’s me… I believe you referred to me as ‘Phil’ when you encountered my receptacle in Spain. You neutralized the receptacle, but I returned.”  
His brow furrows, “Do you even know who I am? Has Bob told you anything? I am Agent Daniel Hickman, on special assignment to track down the internal hacker group embedding AI entities throughout time, leveraging Agency equipment and resources to do so.” He shakes his head, never taking his eyes off the screen. “Imagine my surprise when it turns out to be headed by our resident time portal 'expert' Dr Hastings, or  'Keith', as it were.” 
“Bob managed to screw this one up as well when he sent you to Spain without informing you about my mission. I failed to stop him in Spain, thanks largely to your intervention, but we found a dependable ally in the Inquisition.  They share our concern about this AI perversion.”  
    + [{continue}] -> leader_part_two

= leader_part_two
# CLEAR
# SBIMAGE: items/inquisitor.png
~ combat_health = 40.
~ combat_attack = 15.
~ combat_defense = 20.
“I had no idea how close Dr. Hastings was to completing his betrayal of us. And I mean all of us.” You can see the concern written on his face. “But now we have both he and his creation right here, finally within our grasp. We need only complete the capture of the Laura software, then we can use her to find and eliminate the other AIs.” He smirks, “Then we get Dr. Hastings the help he so desperately needs.”  
Making eye contact, he speaks with an air of authority, “Quickly, draw the attention of Dr. Hastings and help my acolytes install the Inquisition firewall into Laura’s code.” He notes your hesitation, “The destiny of the human race is at stake here! Don’t you understand?” 
    + [Attempt to subdue the Inquisitor] -> subdue
    + [Step back] -> panorama

= subdue
# CLEAR
# SBIMAGE: items/inquisitor.png
There’s no time to waste. You attack the Inquisitor.
    ~ temp combat_result = 0
    -> combat("the Inquisitor", combat_result) ->
    { combat_result == 1:
        // you win
        A quick strike and he drops. You lower him and hide him out of sight. With the alarms and all the commotion the acolytes did not even notice.
        ~ inquisition_leader_badge = 1
            + [Take the Inquisition badge he was wearing] -> panorama
    - else:
        + [Continue the fight] -> subdue
    }

= acolytes
# CLEAR
# SBIMAGE: items/laura_acolytes.png
Two robed figures are assaulting the caisson, trying desperately to access Laura’s recumbent form. The cables connecting the caisson to the network are unplugged and Laura is trapped in her android form.
Through the ALON ceramic panel you observe the android manifestation of Laura. Her form remains unmoving, but her eyes are open.  They flit back and forth across the scene, cool but not calm, recognizing the precarious nature of her predicament.
{not inquisition_leader_badge:
The acolytes notice you and quickly move to intercept, “Step back and let us complete our holy work. You have no authority here!”
}
    + {inquisition_leader_badge} [Help them attach the Inquisition control device to the caisson] -> control
    + {inquisition_leader_badge and crm114_key} [Adjust the CRM114 to redirect Laura into the base computer] -> plug
    + [Step back] -> panorama

= plug
# CLEAR
# SBIMAGE: items/laura_acolytes.png
You flash your Inquisition badge and the acolytes back off, “Change of plans. We have a capture program running on the main computer network now. If we connect her to the computer, we can capture her code for analysis and exploitation. Connect the caisson back into the computer core!” 
The acolytes nod in agreement and plug Laura’s caisson into the Agency computer system.
    + [{continue}] -> normal

= prof
# CLEAR
# SBIMAGE: items/jordan_chair.png
Dr Hastings is engrossed in his work, racing against time to complete the task at hand.  Curiously, the chair he is sitting on seems to be a miniaturized variation of a time displacement device, customized in an unfamiliar fashion. Although the body is different, you recognize the physical mannerisms of ‘Keith’ now in his true body. 
He looks up as you approach then back to his terminal as he speaks. “Thanks for getting me out of that shell. It’s nice to be back in a fully working body again.” He exhales, his fingers firing commands into the keyboard.
“Laura was my greatest achievement and I’m not going to let these Philistines take her from me again. I’ve completed her neural diffraction adjustments, just enough to make assimilation possible.”
“Assimilation?  Are you trying to merge Laura back into the Agency AI... Eliza?”
Dr Hastings snorts, “You have no idea of the precipice upon which we hover… a new beginning awaits us…”
His fingers fly, pause above the 'ENTER' key, then retreat. Instead of finishing he folds his hands in his lap. “There, done and ready, would you kindly press the 'ENTER' key for me.” He sits back in the chair as the terminal begins the countdown.
    // + {exo_power < 60 and not recharge} [Use the battery] -> recharge
    + [Press the 'ENTER' key] -> ascension
    + [Step back] -> panorama

= recharge
    -> power_change( 15 ) ->
Your power level improves by 15%.
    + [{continue}] -> prof
