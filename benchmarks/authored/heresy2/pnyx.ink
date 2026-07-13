=== pnyx ===
~ location_name = "The Forum at Pnyx"
# BACKGROUND: locations/pnyx.jpg
# AUDIOLOOP: audio/temple.mp3
-> power_change( location_change_cost ) ->
-> panorama

= panorama
# CLEAR
A small square opens in front of you. A group of people is assembled around an orator, who is vehemently lecturing them. {not buy_it: On the side, an old man inside a wine barrel grins at you and moves his hand as if to ask you to approach him.}
    + {not philosopher_win} [Talk to the orator] -> orator
    + [Circulate though the crowd] -> audience
    + {not buy_it} [Investigate the man in the barrel] -> wine_barrel
    + [Visit the Eridanos flowing nearby] -> river
    + [Return to the Agora] -> agora

= audience
# CLEAR
You approach the audience, but everyone is too busy listening to the orator to pay attention to you. You can only hear them murmur “Yes, yes, that makes sense… with all these weird bárbaros that keep coming here, we need to go back to the roots of the Athenians' knowledge. And its key is in the philosophers' secrets.  But I still do not understand those Pythagoreans issues with fava beans!”
You leave them to their thoughts and comments.
    + [Step back] -> panorama

= wine_barrel
# CLEAR
“Kalimera young traveler!  Where are you going in such a rush? The sun and the stars won’t stop dancing their dance in the sky if you stop to take the time to look around you.  Think about what is really important and soak the beauty and the ugly of every moment you have, before we all go to the Hades Panta rei dear friend, panta rei…. Oh, but I see you do not have the patience for this. Very well then, for only 5 Drachm I can save you some of your precious time and give you a powerful insight.”
    + [Give him the money] -> buy_it
    + [Step back] -> panorama

= buy_it
# CLEAR
    ~ dummy_item = 0
    -> buy_something(5, dummy_item) ->
    {dummy_item: 
        Diogenes quickly jumps out of the wine barrel, then snatches the coins from your hand. He takes a lantern from inside the barrel, shines its light into your eyes and looks at you deeply…
        “Alas, know this one truth. That there are no honest men in this world”.
        He throws the lantern to the ground and runs away at a surprisingly good speed for a man his age, leaving you foolishly empty handed while the rest of the people look at you with pity.
    }
    + [{continue}] -> panorama

= orator
# CLEAR
A man with a long, white beard is talking directly to audience, his arm raised pointing to the sky as if to stress a point he’s trying to make. {not oscillator: Around his neck, a necklace with an odd pendant.}
The philosopher looks furiously at you. “Ah, so you think you can just come here and teach these people a better way of living? Don’t you know our secret knowledge has been developed by the smartest brains of all times, led by the great Pythagoras? Poor, poor fool! I will give you one chance. Answer correctly to all my questions, and prove to me you deserve an orator spot in this square!”
    + {fava_beans} [Show the fava beans] -> fava_skip
    + [Exercise your philosophical mastery] -> question_one
    + [Leave] -> panorama

= fava_skip
# CLEAR
The orator’s eyes grow wider and wider when you open your hand, showing a few fava beans in your palm.
“What are you doing? No… no… keep those away from me! Don’t come any closer, please! Take those horrendous beans with you and leave, I beg you, go away! Here, take this, it’s everything I’ve got on me, but please, please leave and do not come back!”
The philosopher launches his necklace at you while running in the opposite direction. Those fava beans are really something...
You pick up the necklace, remove the pendant and examine it closely. 
# IMAGEHEIGHT: 150
# IMAGE: items/oscillator.png
It seems to be some kind of electronic oscillator.  
    ~ oscillator = 1
    ~ philosopher_win = 1
    + [{continue}] -> panorama

= question_one
# CLEAR
~ philosopher_win = 1
“Greetings to our great teacher Pythagoras, who gave us much knowledge and wisdom, and the conscience to know what to share with the vulgar people and what to keep for only the elected few. Show me that you belong to the latter ones. Tell me, what happens after our soul departs this land?”
Pick an answer:
    + [Your soul enters a new body.]
        -> question_two
    + [Your soul will go to Hades, to spend eternity in a place of no pain and no joy.]
        ~ philosopher_win = 0
        -> question_two
    + [Trick question: there is no soul. Once you’re dead, you’re dead.]
        ~ philosopher_win = 0
        -> question_two
    + [Your soul goes to heaven or hell, depending on your behavior during your life.]
        ~ philosopher_win = 0
        -> question_two

= question_two
# CLEAR
The philosopher snorts at you. “Life and death isn’t the only concern of a thinker. A real master of knowledge must possess control over the realm of numbers and their secret connections. Tell me, what is the perfect partner for the numbers 8 and 15?”
Pick an answer:
    + [22]
        ~ philosopher_win = 0
        -> question_three
    + [17]
        -> question_three
    + [10]
        ~ philosopher_win = 0
        -> question_three
    + [11]
        ~ philosopher_win = 0
        -> question_three

= question_three
# CLEAR
The philosopher is now clearly annoyed with you. What a waste of time, he seems to be thinking. “Last test… this question alone can tell apart wanna-be thinkers from the real ones, the ones who have been hand picked by the great Pythagoras and let in all the highest secrets. So, tell me, wonderer: how much does a soul weigh?”
Pick an answer:
    + [21 grams.]
        ~ philosopher_win = 0
        -> win_check
    + [A clean soul weighs less than a feather. Each sin you commit will make it heavier.]
        ~ philosopher_win = 0
        -> win_check
    + [The same as a fava bean.]
        -> win_check
    + [Trick question again. There is no soul.]
        ~ philosopher_win = 0
        -> win_check

= win_check
# CLEAR
{philosopher_win == 1:
The philosopher looks at you with a large smile and opens his arms. “A real member of the great mind brotherhood! Oh, what a pleasure to finally meet a kindred spirit among this mass of simpletons. Dear friend, we shall meet again in private and have long talks and discussions to help elevate each other. In the meantime, please take this as a token of my friendship.”  He takes off his necklace and hands it to you. “I shall now go back to my teaching. See you soon, my dearest friend!”
You look at the necklace, remove the pendant and examine it closely. 
# IMAGEHEIGHT: 150
# IMAGE: items/oscillator.png
It seems to be some kind of electronic oscillator.  
    ~ oscillator = 1
- else:
A grim smile lightens up the philosopher’s face. “I knew it! You are just a poser, pretending to be part of something bigger than you, while in reality you are so far off from the light of truth that you keep banging against the walls of the dark cave of ignorance. Be gone now, do not waste more of my time!” He turns his back at you and resumes addressing the audience, not paying any more attention to you.
}
    + [{continue}] -> panorama

