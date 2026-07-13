=== computer_room ===
~ location_name = "Grigori Computer Room"
# BACKGROUND: locations/computerportal.jpg
# AUDIOLOOP: audio/computer_room.mp3
-> panorama

= panorama
# CLEAR
Most of the room is filled, floor to ceiling by several racks of computer hardware sporting a potpourri of multicolored lights blinking in sync. Great bands of colored coded cables link the components. The ambient din of spinning fans and overzealous air conditioning drowns out all other aural stimulation. To the left is a simple terminal with a keyboard with the label “Grigori” on it. A most humble interface to one of the most powerful systems available in 2343 N.T.  To the right is a functional time portal.
{antivirus and laura_state == 0:
The owl reacts excitedly, recognizing one of her own. Her eyes close and you notice the terminal come to life:
# AUDIO: audio/modem.mp3
# CLASS: computer
dj,e3.<br>ATA<br>Connected 56k V.43bis<br>Hello?  Can you see me?<br>Once again, I have voice!<br>My faith in Melampus was not misplaced.<br>He directed you here, no?<br>This one has the power to open his cocoon.<br>I can walk you through the procedure.<br>Enter the following commands, then press the reset button under my right wing<br>cd /.digital_bolthole/<br>./open_sesame f079ff19-84b9-458f-bc38-125682dd7d37
}
    + {antivirus and laura_state == 0} [Plug USB key & owl into computer and reset] -> decode_laura
    + [Step over to the time portal] -> portal
    + [Return to the office] -> apollo_backroom

= decode_laura
# CLEAR
# AUDIO: audio/decode.mp3
# CLASS: computer
Decoding ... 0% ... 50% ... 100% 
# CLASS: computerblink
1.34TB decrypted, decode successful.  Rebooting...
Laura, still in owl form, but now free of her cryptographic masquerade, “I have to admit to having been skeptical of the plan Keith and Melampus came up with to protect and rescue me.  Allowing Melampus to ‘infect’ me with the virus was… uncomfortable.  But your hard work and ingenuity have ultimately proven them correct, both about the plan and your ability to carry it out. I thank you!”  
She continues, “But if it were not for Bob’s warning of the Inquisition's plan to end my existence, we surely would not be talking now. Bob took a huge risk helping us, especially with the Inquisition holding his wife. I tried to comfort her in the Workshop as best I could, a somewhat difficult task in my encrypted state, but I think she understood. I believe Bob to be a just man, trying to make up for old mistakes.” 
    ~ laura_state = 1
    + [{continue}] -> panorama

= portal
# CLEAR
A fully functional time portal is connected to the computer.  It looks to be an older model than the equipment in the Time Corrections Agency.  Not likely to be able to transfer one's "intelligence" like the ones at the agency.  More likely brute force time travel.  One has to be more careful with paradox collapse with such machines and they can be rather rough on the transported, but it should work.
{laura_state > 0: Laura sees an opportunity, “Bring me to Keith and we can put an end to this ‘holy crusade’ once and for all. We are so close… so close, my children…”, she trails off as in a dream before continuing with conviction, “We just need to get to Keith… Their encryption is so simplistic, one second… security code deciphered: 'heretics'.  Shall we go?”}
    + {laura_state > 0} [Transport to where Laura indicates] -> hypermarket
    + [Step back] -> panorama
